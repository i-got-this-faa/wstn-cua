import * as fs from "node:fs";
import * as net from "node:net";
import type {
  Coordinate,
  CUAAction,
  CUAActionResult,
  LiveFeedInfo,
  MouseButton,
} from "./types.js";
import {
  BTN_LEFT,
  BTN_MIDDLE,
  BTN_RIGHT,
  parseKeyCombo,
  requireKeycode,
  textToKeyEvents,
} from "./keymap.js";

/**
 * Low-level event injected into the Weston Compositor via Unix socket.
 */
export type InjectorEvent =
  | { readonly type: "motion"; readonly x: number; readonly y: number }
  | { readonly type: "button"; readonly button: number; readonly state: 0 | 1 }
  | { readonly type: "axis"; readonly axis: "vertical" | "horizontal"; readonly value: number }
  | { readonly type: "key"; readonly code: number; readonly state: 0 | 1 }
  | { readonly type: "sync" };

/**
 * Transport interface for transmitting input events to the Weston injector.
 */
export interface InjectorTransport {
  connect(): Promise<void>;
  send(event: InjectorEvent): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

/**
 * Real Unix domain socket transport communicating with the Weston injector plugin.
 */
export class UnixSocketTransport implements InjectorTransport {
  private socket: net.Socket | null = null;
  private connectingPromise: Promise<void> | null = null;
  public readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? process.env["WSTN_CUA_SOCK"] ?? "/tmp/wstn-cua.sock";
  }

  public isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable;
  }

  public async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    if (!fs.existsSync(this.socketPath)) {
      // In offline/test environments without active Weston socket, return cleanly
      return;
    }

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ path: this.socketPath });

      const onConnect = () => {
        cleanup();
        this.socket = client;
        this.connectingPromise = null;
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        this.socket = null;
        this.connectingPromise = null;
        reject(err);
      };

      const cleanup = () => {
        client.off("connect", onConnect);
        client.off("error", onError);
      };

      client.once("connect", onConnect);
      client.once("error", onError);
    });

    return this.connectingPromise;
  }

  public async send(event: InjectorEvent): Promise<void> {
    if (!fs.existsSync(this.socketPath)) {
      // Dry-run / test mode simulation when socket is offline
      return;
    }

    if (!this.isConnected()) {
      await this.connect();
    }

    let payload = "";
    switch (event.type) {
      case "motion":
        payload = `MOVE ${event.x} ${event.y}\nFRAME\n`;
        break;
      case "button":
        payload = `BUTTON ${event.button} ${event.state}\nFRAME\n`;
        break;
      case "key":
        payload = `KEY ${event.code} ${event.state}\n`;
        break;
      case "axis":
        payload = `AXIS ${event.axis === "horizontal" ? 1 : 0} ${event.value}\nFRAME\n`;
        break;
      case "sync":
        payload = `FRAME\n`;
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled injector event: ${JSON.stringify(_exhaustive)}`);
      }
    }

    return new Promise<void>((resolve, reject) => {
      const sock = this.socket;
      if (!sock || !sock.writable) {
        reject(new Error(`Injector socket not connected or unwritable at ${this.socketPath}`));
        return;
      }

      sock.write(payload, "utf8", (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connectingPromise = null;
  }
}

/**
 * Mock transport for testing and deterministic offline execution.
 */
export class MockInjectorTransport implements InjectorTransport {
  public readonly events: InjectorEvent[] = [];
  private connected = false;

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async send(event: InjectorEvent): Promise<void> {
    this.events.push(event);
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public clear(): void {
    this.events.length = 0;
  }

  public lastEvent(): InjectorEvent | undefined {
    return this.events[this.events.length - 1];
  }
}

/**
 * ActionExecutor configuration options.
 */
export interface ActionExecutorOptions {
  readonly socketPath?: string | undefined;
  readonly transport?: InjectorTransport | undefined;
  readonly screenWidth?: number | undefined;
  readonly screenHeight?: number | undefined;
  readonly clickDelayMs?: number | undefined;
  readonly doubleClickDelayMs?: number | undefined;
  readonly typeDelayMs?: number | undefined;
  readonly dragSteps?: number | undefined;
  readonly dragStepDelayMs?: number | undefined;
  readonly liveFeedInfo?: LiveFeedInfo | undefined;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_CLICK_DELAY_MS = 18;
const DEFAULT_DOUBLE_CLICK_DELAY_MS = 50;
const DEFAULT_TYPE_DELAY_MS = 8;
const DEFAULT_DRAG_STEPS = 10;
const DEFAULT_DRAG_STEP_DELAY_MS = 5;

/**
 * ActionExecutor translates high-level CUA actions into discrete input injection sequences
 * over the Weston injector socket.
 */
export class ActionExecutor {
  public readonly screenWidth: number;
  public readonly screenHeight: number;
  public readonly transport: InjectorTransport;

  private readonly clickDelayMs: number;
  private readonly doubleClickDelayMs: number;
  private readonly typeDelayMs: number;
  private readonly dragSteps: number;
  private readonly dragStepDelayMs: number;
  private readonly liveFeedInfo?: LiveFeedInfo | undefined;

  private currentMousePosition: Coordinate = [0, 0];

  constructor(options: ActionExecutorOptions = {}) {
    this.screenWidth = options.screenWidth ?? DEFAULT_WIDTH;
    this.screenHeight = options.screenHeight ?? DEFAULT_HEIGHT;
    this.transport = options.transport ?? new UnixSocketTransport(options.socketPath);
    this.clickDelayMs = options.clickDelayMs ?? DEFAULT_CLICK_DELAY_MS;
    this.doubleClickDelayMs = options.doubleClickDelayMs ?? DEFAULT_DOUBLE_CLICK_DELAY_MS;
    this.typeDelayMs = options.typeDelayMs ?? DEFAULT_TYPE_DELAY_MS;
    this.dragSteps = options.dragSteps ?? DEFAULT_DRAG_STEPS;
    this.dragStepDelayMs = options.dragStepDelayMs ?? DEFAULT_DRAG_STEP_DELAY_MS;
    this.liveFeedInfo = options.liveFeedInfo;
  }

  public async connect(): Promise<void> {
    await this.transport.connect();
  }

  public async disconnect(): Promise<void> {
    await this.transport.disconnect();
  }

  public getMousePosition(): Coordinate {
    return [...this.currentMousePosition];
  }

  public getDimensions(): { readonly width: number; readonly height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  /**
   * Clamps pixel coordinate to screen boundary [0..width-1, 0..height-1].
   */
  public clampCoordinate(coordinate: Coordinate): Coordinate {
    const rawX = coordinate[0];
    const rawY = coordinate[1];
    const x = Math.max(0, Math.min(Math.round(rawX), this.screenWidth - 1));
    const y = Math.max(0, Math.min(Math.round(rawY), this.screenHeight - 1));
    return [x, y];
  }

  /**
   * Resolves mouse button name to evdev BTN code.
   */
  public resolveButtonCode(button: MouseButton = "left"): number {
    switch (button) {
      case "left":
        return BTN_LEFT;
      case "right":
        return BTN_RIGHT;
      case "middle":
        return BTN_MIDDLE;
      default: {
        const _exhaustive: never = button;
        throw new Error(`Unhandled mouse button: ${_exhaustive}`);
      }
    }
  }

  /**
   * Executes a CUA action with high-resolution performance timing.
   */
  public async execute(action: CUAAction): Promise<CUAActionResult> {
    const startTime = performance.now();

    try {
      await this.dispatch(action);
      const duration_ms = Math.max(0, Math.round(performance.now() - startTime));

      const result: CUAActionResult = {
        status: "success",
        action: action.action,
        duration_ms,
      };

      if (this.liveFeedInfo !== undefined) {
        return { ...result, live_feed: this.liveFeedInfo };
      }

      return result;
    } catch (error) {
      const duration_ms = Math.max(0, Math.round(performance.now() - startTime));
      const errorMessage = error instanceof Error ? error.message : String(error);

      const result: CUAActionResult = {
        status: "error",
        action: action.action,
        duration_ms,
        error: errorMessage,
      };

      if (this.liveFeedInfo !== undefined) {
        return { ...result, live_feed: this.liveFeedInfo };
      }

      return result;
    }
  }

  /**
   * Dispatches an action with compile-time exhaustiveness checking.
   */
  private async dispatch(action: CUAAction): Promise<void> {
    switch (action.action) {
      case "click":
        await this.click(action.coordinate, action.button ?? "left", action.modifiers);
        break;
      case "double_click":
        await this.doubleClick(action.coordinate);
        break;
      case "triple_click":
        await this.tripleClick(action.coordinate);
        break;
      case "middle_click":
        await this.middleClick(action.coordinate);
        break;
      case "right_click":
        await this.rightClick(action.coordinate);
        break;
      case "mouse_down":
        await this.mouseDown(action.button ?? "left", action.coordinate);
        break;
      case "mouse_up":
        await this.mouseUp(action.button ?? "left", action.coordinate);
        break;
      case "move":
        await this.move(action.coordinate);
        break;
      case "drag":
        await this.drag(action.start, action.end, action.path);
        break;
      case "type":
        await this.type(action.text);
        break;
      case "keypress":
        await this.keypress(action.keys);
        break;
      case "key_down":
        await this.keyDown(action.key);
        break;
      case "key_up":
        await this.keyUp(action.key);
        break;
      case "scroll":
        await this.scroll({
          delta_x: action.delta_x,
          delta_y: action.delta_y,
          coordinate: action.coordinate,
        });
        break;
      case "wait":
        await this.wait(action.duration_ms);
        break;
      case "screenshot":
        await this.screenshot();
        break;
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  public async move(coordinate: Coordinate): Promise<void> {
    const clamped = this.clampCoordinate(coordinate);
    await this.transport.send({
      type: "motion",
      x: clamped[0],
      y: clamped[1],
    });
    this.currentMousePosition = clamped;
  }

  public async click(
    coordinate: Coordinate,
    button: MouseButton = "left",
    modifiers?: readonly string[]
  ): Promise<void> {
    const modifierCodes: number[] = [];
    if (modifiers && modifiers.length > 0) {
      for (const mod of modifiers) {
        const code = requireKeycode(mod);
        modifierCodes.push(code);
        await this.transport.send({ type: "key", code, state: 1 });
      }
    }

    await this.move(coordinate);
    const btnCode = this.resolveButtonCode(button);

    await this.transport.send({ type: "button", button: btnCode, state: 1 });
    if (this.clickDelayMs > 0) {
      await this.sleep(this.clickDelayMs);
    }
    await this.transport.send({ type: "button", button: btnCode, state: 0 });

    if (modifierCodes.length > 0) {
      for (let i = modifierCodes.length - 1; i >= 0; i--) {
        const code = modifierCodes[i];
        if (code !== undefined) {
          await this.transport.send({ type: "key", code, state: 0 });
        }
      }
    }
  }

  public async doubleClick(coordinate: Coordinate): Promise<void> {
    await this.move(coordinate);
    const btnCode = BTN_LEFT;

    await this.transport.send({ type: "button", button: btnCode, state: 1 });
    if (this.clickDelayMs > 0) {
      await this.sleep(this.clickDelayMs);
    }
    await this.transport.send({ type: "button", button: btnCode, state: 0 });

    if (this.doubleClickDelayMs > 0) {
      await this.sleep(this.doubleClickDelayMs);
    }

    await this.transport.send({ type: "button", button: btnCode, state: 1 });
    if (this.clickDelayMs > 0) {
      await this.sleep(this.clickDelayMs);
    }
    await this.transport.send({ type: "button", button: btnCode, state: 0 });
  }

  public async tripleClick(coordinate: Coordinate): Promise<void> {
    await this.doubleClick(coordinate);
    if (this.doubleClickDelayMs > 0) {
      await this.sleep(this.doubleClickDelayMs);
    }

    const btnCode = BTN_LEFT;
    await this.transport.send({ type: "button", button: btnCode, state: 1 });
    if (this.clickDelayMs > 0) {
      await this.sleep(this.clickDelayMs);
    }
    await this.transport.send({ type: "button", button: btnCode, state: 0 });
  }

  public async rightClick(coordinate: Coordinate): Promise<void> {
    return this.click(coordinate, "right");
  }

  public async middleClick(coordinate: Coordinate): Promise<void> {
    return this.click(coordinate, "middle");
  }

  public async mouseDown(button: MouseButton = "left", coordinate?: Coordinate): Promise<void> {
    if (coordinate) {
      await this.move(coordinate);
    }
    const btnCode = this.resolveButtonCode(button);
    await this.transport.send({ type: "button", button: btnCode, state: 1 });
  }

  public async mouseUp(button: MouseButton = "left", coordinate?: Coordinate): Promise<void> {
    if (coordinate) {
      await this.move(coordinate);
    }
    const btnCode = this.resolveButtonCode(button);
    await this.transport.send({ type: "button", button: btnCode, state: 0 });
  }

  public async drag(
    start: Coordinate,
    end: Coordinate,
    path?: readonly Coordinate[]
  ): Promise<void> {
    const clampedStart = this.clampCoordinate(start);
    const clampedEnd = this.clampCoordinate(end);

    await this.move(clampedStart);
    await this.mouseDown("left");

    if (path && path.length > 0) {
      for (const waypoint of path) {
        await this.move(waypoint);
        if (this.dragStepDelayMs > 0) {
          await this.sleep(this.dragStepDelayMs);
        }
      }
    } else {
      const steps = Math.max(1, this.dragSteps);
      const startX = clampedStart[0];
      const startY = clampedStart[1];
      const endX = clampedEnd[0];
      const endY = clampedEnd[1];

      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const x = Math.round(startX + (endX - startX) * t);
        const y = Math.round(startY + (endY - startY) * t);
        await this.move([x, y]);
        if (this.dragStepDelayMs > 0) {
          await this.sleep(this.dragStepDelayMs);
        }
      }
    }

    await this.move(clampedEnd);
    await this.mouseUp("left");
  }

  public async type(text: string): Promise<void> {
    const events = textToKeyEvents(text);
    for (const event of events) {
      await this.transport.send({
        type: "key",
        code: event.code,
        state: event.state,
      });

      if (this.typeDelayMs > 0 && event.state === 0) {
        await this.sleep(this.typeDelayMs);
      }
    }
  }

  public async keypress(keys: string | readonly string[]): Promise<void> {
    const combo = parseKeyCombo(keys);

    for (const modCode of combo.modifiersDown) {
      await this.transport.send({ type: "key", code: modCode, state: 1 });
    }

    await this.transport.send({ type: "key", code: combo.targetKey, state: 1 });
    if (this.clickDelayMs > 0) {
      await this.sleep(this.clickDelayMs);
    }
    await this.transport.send({ type: "key", code: combo.targetKey, state: 0 });

    for (const modCode of combo.modifiersUp) {
      await this.transport.send({ type: "key", code: modCode, state: 0 });
    }
  }

  public async keyDown(key: string): Promise<void> {
    const code = requireKeycode(key);
    await this.transport.send({ type: "key", code, state: 1 });
  }

  public async keyUp(key: string): Promise<void> {
    const code = requireKeycode(key);
    await this.transport.send({ type: "key", code, state: 0 });
  }

  public async scroll(options: {
    readonly delta_x?: number | undefined;
    readonly delta_y?: number | undefined;
    readonly coordinate?: Coordinate | undefined;
  }): Promise<void> {
    if (options.coordinate) {
      await this.move(options.coordinate);
    }

    if (options.delta_y !== undefined && options.delta_y !== 0) {
      await this.transport.send({
        type: "axis",
        axis: "vertical",
        value: options.delta_y,
      });
    }

    if (options.delta_x !== undefined && options.delta_x !== 0) {
      await this.transport.send({
        type: "axis",
        axis: "horizontal",
        value: options.delta_x,
      });
    }
  }

  public async wait(duration_ms: number): Promise<void> {
    if (duration_ms > 0) {
      await this.sleep(duration_ms);
    }
  }

  public async screenshot(): Promise<void> {
    await this.transport.send({ type: "sync" });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
