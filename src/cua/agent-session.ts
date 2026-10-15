import type { Coordinate, CUAAction, CUAActionResult } from "./types.js";
import { parseCUAAction } from "./types.js";
import { ActionExecutor, type ActionExecutorOptions } from "./action-executor.js";
import { isModifierKey, requireKeycode } from "./keymap.js";

/**
 * Historical record of an action executed within the session.
 */
export interface SessionHistoryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly action: CUAAction;
  readonly result: CUAActionResult;
}

/**
 * Options for configuring CUAAgentSession.
 */
export interface CUAAgentSessionOptions {
  readonly executor?: ActionExecutor | undefined;
  readonly executorOptions?: ActionExecutorOptions | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly maxHistory?: number | undefined;
  readonly initialMousePosition?: Coordinate | undefined;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_MAX_HISTORY = 1000;

/**
 * CUAAgentSession manages the lifecycle, state tracking, and sequential execution queue
 * for OpenAI Computer Use Agents interacting with the Weston desktop.
 */
export class CUAAgentSession {
  public readonly width: number;
  public readonly height: number;
  public readonly executor: ActionExecutor;

  private readonly maxHistory: number;
  private mousePosition: Coordinate;
  private readonly activeModifiers = new Set<string>();
  private readonly history: SessionHistoryEntry[] = [];
  private queuePromise: Promise<unknown> = Promise.resolve();

  constructor(options: CUAAgentSessionOptions = {}) {
    this.width = options.width ?? options.executor?.screenWidth ?? DEFAULT_WIDTH;
    this.height = options.height ?? options.executor?.screenHeight ?? DEFAULT_HEIGHT;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.mousePosition = options.initialMousePosition ?? [0, 0];

    if (options.executor) {
      this.executor = options.executor;
    } else {
      this.executor = new ActionExecutor({
        screenWidth: this.width,
        screenHeight: this.height,
        ...options.executorOptions,
      });
    }
  }

  /**
   * Screen dimensions in pixels.
   */
  public getDimensions(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Current tracked mouse pointer position [x, y].
   */
  public getMousePosition(): Coordinate {
    return [...this.mousePosition];
  }

  /**
   * Currently held active keyboard modifier names.
   */
  public getActiveModifiers(): readonly string[] {
    return Array.from(this.activeModifiers);
  }

  /**
   * Chronological history of executed actions and results.
   */
  public getHistory(): readonly SessionHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Clears session execution history.
   */
  public clearHistory(): void {
    this.history.length = 0;
  }

  /**
   * Enqueues a CUA action for sequential execution.
   * Concurrent calls are safely chained to prevent race conditions in desktop input.
   */
  public async executeAction(action: unknown): Promise<CUAActionResult> {
    const run = async (): Promise<CUAActionResult> => {
      const validatedAction = parseCUAAction(action);
      const result = await this.executor.execute(validatedAction);

      if (result.status === "success") {
        this.updateStateOnSuccess(validatedAction);
      }

      const entry: SessionHistoryEntry = {
        id: `cua-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        action: validatedAction,
        result,
      };

      this.history.push(entry);
      if (this.history.length > this.maxHistory) {
        this.history.shift();
      }

      return result;
    };

    const next = this.queuePromise.then(run, run);
    this.queuePromise = next.catch(() => {});
    return next;
  }

  /**
   * Executes multiple CUA actions sequentially.
   */
  public async executeActions(actions: readonly unknown[]): Promise<readonly CUAActionResult[]> {
    const results: CUAActionResult[] = [];
    for (const action of actions) {
      const res = await this.executeAction(action);
      results.push(res);
      if (res.status === "error") {
        break;
      }
    }
    return results;
  }

  /**
   * Releases any active modifiers, releases mouse buttons, and re-centers cursor.
   */
  public async reset(): Promise<void> {
    const run = async (): Promise<void> => {
      // Release held modifiers
      for (const mod of Array.from(this.activeModifiers)) {
        try {
          await this.executor.keyUp(mod);
        } catch {
          // Ignore
        }
      }
      this.activeModifiers.clear();

      // Release mouse buttons
      try {
        await this.executor.mouseUp("left");
        await this.executor.mouseUp("right");
        await this.executor.mouseUp("middle");
      } catch {
        // Ignore
      }

      // Reset cursor position to origin or center
      const centerX = Math.round(this.width / 2);
      const centerY = Math.round(this.height / 2);
      await this.executor.move([centerX, centerY]);
      this.mousePosition = [centerX, centerY];
    };

    const next = this.queuePromise.then(run, run);
    this.queuePromise = next.catch(() => {});
    return next;
  }

  /**
   * Disposes session and disconnects underlying transport.
   */
  public async dispose(): Promise<void> {
    await this.reset();
    await this.executor.disconnect();
  }

  private updateStateOnSuccess(action: CUAAction): void {
    // 1. Mouse coordinate tracking
    switch (action.action) {
      case "click":
      case "double_click":
      case "triple_click":
      case "middle_click":
      case "right_click":
      case "move":
        this.mousePosition = this.executor.getMousePosition();
        break;
      case "mouse_down":
      case "mouse_up":
      case "scroll":
        if (action.coordinate) {
          this.mousePosition = this.executor.getMousePosition();
        }
        break;
      case "drag":
        this.mousePosition = this.executor.getMousePosition();
        break;
      default:
        break;
    }

    // 2. Modifier key tracking
    if (action.action === "key_down") {
      if (isModifierKey(action.key)) {
        const canonical = this.canonicalModifierName(action.key);
        this.activeModifiers.add(canonical);
      }
    } else if (action.action === "key_up") {
      if (isModifierKey(action.key)) {
        const canonical = this.canonicalModifierName(action.key);
        this.activeModifiers.delete(canonical);
      }
    }
  }

  private canonicalModifierName(key: string): string {
    try {
      const code = requireKeycode(key);
      return `key_${code}`;
    } catch {
      return key.toLowerCase().trim();
    }
  }
}
