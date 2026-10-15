import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { z } from "zod";
import type { WestonSupervisor } from "../compositor/weston-manager.js";
import type { CUAActionResult } from "../cua/types.js";

// --- CUA Action Zod Schemas ---

export const CoordinateSchema = z.tuple([z.number(), z.number()]);

export const ClickActionSchema = z.object({
  action: z.literal("click"),
  coordinate: CoordinateSchema,
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.string()).optional(),
});

export const DoubleClickActionSchema = z.object({
  action: z.literal("double_click"),
  coordinate: CoordinateSchema,
});

export const TripleClickActionSchema = z.object({
  action: z.literal("triple_click"),
  coordinate: CoordinateSchema,
});

export const MiddleClickActionSchema = z.object({
  action: z.literal("middle_click"),
  coordinate: CoordinateSchema,
});

export const RightClickActionSchema = z.object({
  action: z.literal("right_click"),
  coordinate: CoordinateSchema,
});

export const MouseDownActionSchema = z.object({
  action: z.literal("mouse_down"),
  coordinate: CoordinateSchema.optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
});

export const MouseUpActionSchema = z.object({
  action: z.literal("mouse_up"),
  coordinate: CoordinateSchema.optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
});

export const MoveActionSchema = z.object({
  action: z.literal("move"),
  coordinate: CoordinateSchema,
});

export const DragActionSchema = z.object({
  action: z.literal("drag"),
  start: CoordinateSchema,
  end: CoordinateSchema,
  path: z.array(CoordinateSchema).optional(),
});

export const TypeActionSchema = z.object({
  action: z.literal("type"),
  text: z.string(),
});

export const KeypressActionSchema = z.object({
  action: z.literal("keypress"),
  keys: z.union([z.string(), z.array(z.string())]),
});

export const KeyDownActionSchema = z.object({
  action: z.literal("key_down"),
  key: z.string(),
});

export const KeyUpActionSchema = z.object({
  action: z.literal("key_up"),
  key: z.string(),
});

export const ScrollActionSchema = z.object({
  action: z.literal("scroll"),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  coordinate: CoordinateSchema.optional(),
});

export const WaitActionSchema = z.object({
  action: z.literal("wait"),
  duration_ms: z.number().nonnegative(),
});

export const ScreenshotActionSchema = z.object({
  action: z.literal("screenshot"),
});

export const CUAActionSchema = z.discriminatedUnion("action", [
  ClickActionSchema,
  DoubleClickActionSchema,
  TripleClickActionSchema,
  MiddleClickActionSchema,
  RightClickActionSchema,
  MouseDownActionSchema,
  MouseUpActionSchema,
  MoveActionSchema,
  DragActionSchema,
  TypeActionSchema,
  KeypressActionSchema,
  KeyDownActionSchema,
  KeyUpActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  ScreenshotActionSchema,
]);

export type CUAAction = z.infer<typeof CUAActionSchema>;

export const CUAActionsPayloadSchema = z.union([
  z.object({ action: CUAActionSchema }),
  z.object({ actions: z.array(CUAActionSchema).min(1) }),
  CUAActionSchema,
]);

export type { CUAActionResult };

// --- OpenAI Tool Specification ---

export const OPENAI_CUA_TOOL_SPEC = {
  type: "function",
  function: {
    name: "computer_use",
    description: "Control mouse and keyboard interactions on the Weston CUA desktop display. Coordinates are in pixels with origin (0, 0) at top-left.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "click", "double_click", "triple_click", "middle_click", "right_click",
            "mouse_down", "mouse_up", "move", "drag",
            "type", "keypress", "key_down", "key_up",
            "scroll", "wait", "screenshot"
          ],
          description: "The computer action to perform."
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "[x, y] coordinates in display pixels."
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button for clicks (default: 'left')."
        },
        modifiers: {
          type: "array",
          items: { type: "string" },
          description: "Optional modifier keys to hold during click (e.g. ['ctrl', 'shift'])."
        },
        start: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "Start coordinates for drag operations."
        },
        end: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "End coordinates for drag operations."
        },
        text: {
          type: "string",
          description: "Text to type into the active window."
        },
        keys: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
          ],
          description: "Key or key combination to press (e.g. 'Enter', 'ctrl+c')."
        },
        key: {
          type: "string",
          description: "Single key name for key_down or key_up."
        },
        delta_x: {
          type: "number",
          description: "Horizontal scroll displacement."
        },
        delta_y: {
          type: "number",
          description: "Vertical scroll displacement."
        },
        duration_ms: {
          type: "number",
          description: "Duration to pause in milliseconds."
        }
      },
      required: ["action"]
    }
  }
} as const;

// Minimal valid 320x200 JPEG buffer for snapshot fallback
const FALLBACK_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAMABEDREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
export const FALLBACK_JPEG_BUFFER = Buffer.from(FALLBACK_JPEG_BASE64, "base64");

export interface FrameInfo {
  readonly buffer: Buffer;
  readonly timestamp: number;
  readonly width: number;
  readonly height: number;
  readonly frameId: number;
}

export interface StreamManagerInterface {
  getLatestFrame(): FrameInfo | null;
  handleMjpegStream(req: http.IncomingMessage, res: http.ServerResponse): void;
}

export interface ActionExecutorInterface {
  execute(action: CUAAction): Promise<CUAActionResult>;
  executeAll?(actions: CUAAction[]): Promise<CUAActionResult[]>;
}

export interface ServerContext {
  readonly weston: WestonSupervisor;
  readonly streamManager?: StreamManagerInterface | undefined;
  readonly actionExecutor?: ActionExecutorInterface | undefined;
  readonly portalUrl: string;
  readonly port: number;
  readonly recentAgentActions: CUAActionResult[];
  readonly onActionExecuted?: ((action: CUAAction, result: CUAActionResult) => void) | undefined;
}

// Map OpenAI key names to evdev keycodes
const KEY_NAME_TO_EVDEV: Record<string, number> = {
  esc: 1, escape: 1,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  minus: 12, "-": 12, equal: 13, "=": 13,
  backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  enter: 28, return: 28,
  ctrl: 29, control: 29, control_l: 29, leftctrl: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  semicolon: 39, ";": 39, apostrophe: 40, "'": 40, grave: 41, "`": 41,
  shift: 42, shift_l: 42, leftshift: 42,
  backslash: 43, "\\": 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51, ",": 51, dot: 52, ".": 52, slash: 53, "/": 53,
  shift_r: 54, rightshift: 54,
  alt: 56, alt_l: 56, leftalt: 56,
  space: 57, " ": 57,
  capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
  control_r: 97, rightctrl: 97,
  alt_r: 100, rightalt: 100,
  home: 102, up: 103, arrowup: 103, pageup: 104,
  left: 105, arrowleft: 105, right: 106, arrowright: 106,
  end: 107, down: 108, arrowdown: 108, pagedown: 109,
  insert: 110, delete: 111,
  super: 125, super_l: 125, meta: 125, leftmeta: 125,
};

// Direct socket communicator for Weston input injector
export async function sendDirectSocketCommand(socketPath: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve("");
      return;
    }
    const client = net.createConnection({ path: socketPath });
    let response = "";

    client.on("connect", () => {
      client.write(command.endsWith("\n") ? command : `${command}\n`);
      // Short delay for response if command is PING or INFO
      if (command.startsWith("PING") || command.startsWith("INFO")) {
        client.setTimeout(200);
      } else {
        client.end();
      }
    });

    client.on("data", (data) => {
      response += data.toString("utf8");
      client.end();
    });

    client.on("timeout", () => {
      client.destroy();
      resolve(response);
    });

    client.on("end", () => {
      resolve(response);
    });

    client.on("error", () => {
      // Don't crash if socket not ready
      resolve("");
    });
  });
}

// Fallback executor directly talking to the Weston injector socket
export async function executeFallbackAction(action: CUAAction, context: ServerContext): Promise<CUAActionResult> {
  const startTime = Date.now();
  const socketPath = context.weston.inputSocketPath;
  const BTN_LEFT = 272;
  const BTN_RIGHT = 273;
  const BTN_MIDDLE = 274;

  const btnCode = (b?: "left" | "right" | "middle") => {
    if (b === "right") return BTN_RIGHT;
    if (b === "middle") return BTN_MIDDLE;
    return BTN_LEFT;
  };

  try {
    switch (action.action) {
      case "move": {
        const [x, y] = action.coordinate;
        await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nFRAME\n`);
        break;
      }
      case "click": {
        const [x, y] = action.coordinate;
        const btn = btnCode(action.button);
        await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nBUTTON ${btn} 1\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 40));
        await sendDirectSocketCommand(socketPath, `BUTTON ${btn} 0\nFRAME\n`);
        break;
      }
      case "double_click": {
        const [x, y] = action.coordinate;
        await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nBUTTON 272 1\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 30));
        await sendDirectSocketCommand(socketPath, `BUTTON 272 0\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 70));
        await sendDirectSocketCommand(socketPath, `BUTTON 272 1\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 30));
        await sendDirectSocketCommand(socketPath, `BUTTON 272 0\nFRAME\n`);
        break;
      }
      case "triple_click": {
        const [x, y] = action.coordinate;
        for (let i = 0; i < 3; i++) {
          await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nBUTTON 272 1\nFRAME\n`);
          await new Promise((r) => setTimeout(r, 25));
          await sendDirectSocketCommand(socketPath, `BUTTON 272 0\nFRAME\n`);
          if (i < 2) await new Promise((r) => setTimeout(r, 50));
        }
        break;
      }
      case "right_click": {
        const [x, y] = action.coordinate;
        await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nBUTTON 273 1\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 40));
        await sendDirectSocketCommand(socketPath, `BUTTON 273 0\nFRAME\n`);
        break;
      }
      case "middle_click": {
        const [x, y] = action.coordinate;
        await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\nBUTTON 274 1\nFRAME\n`);
        await new Promise((r) => setTimeout(r, 40));
        await sendDirectSocketCommand(socketPath, `BUTTON 274 0\nFRAME\n`);
        break;
      }
      case "mouse_down": {
        if (action.coordinate) {
          const [x, y] = action.coordinate;
          await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\n`);
        }
        const btn = btnCode(action.button);
        await sendDirectSocketCommand(socketPath, `BUTTON ${btn} 1\nFRAME\n`);
        break;
      }
      case "mouse_up": {
        if (action.coordinate) {
          const [x, y] = action.coordinate;
          await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\n`);
        }
        const btn = btnCode(action.button);
        await sendDirectSocketCommand(socketPath, `BUTTON ${btn} 0\nFRAME\n`);
        break;
      }
      case "drag": {
        const [sx, sy] = action.start;
        const [ex, ey] = action.end;
        await sendDirectSocketCommand(socketPath, `MOVE ${sx} ${sy}\nBUTTON 272 1\nFRAME\n`);
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const ix = Math.round(sx + (ex - sx) * (i / steps));
          const iy = Math.round(sy + (ey - sy) * (i / steps));
          await sendDirectSocketCommand(socketPath, `MOVE ${ix} ${iy}\nFRAME\n`);
          await new Promise((r) => setTimeout(r, 15));
        }
        await sendDirectSocketCommand(socketPath, `BUTTON 272 0\nFRAME\n`);
        break;
      }
      case "scroll": {
        if (action.coordinate) {
          const [x, y] = action.coordinate;
          await sendDirectSocketCommand(socketPath, `MOVE ${x} ${y}\n`);
        }
        if (action.delta_y !== undefined && action.delta_y !== 0) {
          await sendDirectSocketCommand(socketPath, `AXIS 0 ${action.delta_y}\nFRAME\n`);
        }
        if (action.delta_x !== undefined && action.delta_x !== 0) {
          await sendDirectSocketCommand(socketPath, `AXIS 1 ${action.delta_x}\nFRAME\n`);
        }
        break;
      }
      case "type": {
        for (const char of action.text) {
          const keyLower = char.toLowerCase();
          const code = KEY_NAME_TO_EVDEV[keyLower] ?? 0;
          if (code > 0) {
            const isUpper = char >= "A" && char <= "Z";
            if (isUpper) await sendDirectSocketCommand(socketPath, `KEY 42 1\n`);
            await sendDirectSocketCommand(socketPath, `KEY ${code} 1\n`);
            await new Promise((r) => setTimeout(r, 10));
            await sendDirectSocketCommand(socketPath, `KEY ${code} 0\n`);
            if (isUpper) await sendDirectSocketCommand(socketPath, `KEY 42 0\n`);
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        break;
      }
      case "keypress": {
        const keys = Array.isArray(action.keys) ? action.keys : [action.keys];
        for (const keyCombo of keys) {
          const parts = keyCombo.toLowerCase().split("+").map((s) => s.trim());
          const codes = parts.map((p) => KEY_NAME_TO_EVDEV[p] ?? 0).filter((c) => c > 0);
          for (const code of codes) {
            await sendDirectSocketCommand(socketPath, `KEY ${code} 1\n`);
          }
          await new Promise((r) => setTimeout(r, 20));
          for (const code of [...codes].reverse()) {
            await sendDirectSocketCommand(socketPath, `KEY ${code} 0\n`);
          }
        }
        break;
      }
      case "key_down": {
        const code = KEY_NAME_TO_EVDEV[action.key.toLowerCase()] ?? 0;
        if (code > 0) {
          await sendDirectSocketCommand(socketPath, `KEY ${code} 1\n`);
        }
        break;
      }
      case "key_up": {
        const code = KEY_NAME_TO_EVDEV[action.key.toLowerCase()] ?? 0;
        if (code > 0) {
          await sendDirectSocketCommand(socketPath, `KEY ${code} 0\n`);
        }
        break;
      }
      case "wait": {
        await new Promise((r) => setTimeout(r, action.duration_ms));
        break;
      }
      case "screenshot": {
        // Handled naturally via streamManager or live-frame
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled action: ${JSON.stringify(_exhaustive)}`);
      }
    }

    const duration = Date.now() - startTime;
    return {
      status: "success",
      action: action.action,
      duration_ms: duration,
      live_feed: {
        portal_url: context.portalUrl,
        stream_url: `${context.portalUrl}/v1/cua/stream`,
      },
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      status: "error",
      action: action.action,
      duration_ms: duration,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeAction(action: CUAAction, context: ServerContext): Promise<CUAActionResult> {
  let result: CUAActionResult;
  if (context.actionExecutor) {
    result = await context.actionExecutor.execute(action);
  } else {
    result = await executeFallbackAction(action, context);
  }

  context.recentAgentActions.unshift(result);
  if (context.recentAgentActions.length > 50) {
    context.recentAgentActions.pop();
  }

  if (context.onActionExecuted) {
    try {
      context.onActionExecuted(action, result);
    } catch {
      // ignore broadcast failure
    }
  }

  return result;
}

// --- HTTP Route Handlers ---

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error("Request payload too large (>10MB)"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: ServerContext
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // 1. GET /: Web Control Center UI
  if ((method === "GET" || method === "HEAD") && pathname === "/") {
    const webHtmlPath = path.resolve(process.cwd(), "src/web/index.html");
    if (fs.existsSync(webHtmlPath)) {
      const html = fs.readFileSync(webHtmlPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": html.length,
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(html);
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Web Control Center index.html not found");
    return;
  }

  // 1b. Static web assets
  if ((method === "GET" || method === "HEAD") && (pathname === "/app.js" || pathname === "/src/web/app.js")) {
    const appJsPath = path.resolve(process.cwd(), "src/web/app.js");
    if (fs.existsSync(appJsPath)) {
      const js = fs.readFileSync(appJsPath);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": js.length,
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(js);
      }
      return;
    }
  }

  // 2. GET /v1/cua/stream: Live multipart MJPEG video stream
  if (method === "GET" && pathname === "/v1/cua/stream") {
    if (context.streamManager) {
      context.streamManager.handleMjpegStream(req, res);
      return;
    }

    // Built-in MJPEG continuous streamer
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=wstnframe",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
    });

    const sendFrame = () => {
      const frameBuffer = FALLBACK_JPEG_BUFFER;
      const header = `--wstnframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`;
      res.write(header);
      res.write(frameBuffer);
      res.write("\r\n");
    };

    sendFrame();
    const interval = setInterval(sendFrame, 150);

    req.on("close", () => {
      clearInterval(interval);
    });
    return;
  }

  // 3. GET /v1/cua/live-frame: Current JPEG snapshot
  if (method === "GET" && pathname === "/v1/cua/live-frame") {
    let frameBuffer: Buffer = FALLBACK_JPEG_BUFFER;
    if (context.streamManager) {
      const latest = context.streamManager.getLatestFrame();
      if (latest) {
        frameBuffer = Buffer.from(latest.buffer);
      }
    }

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": frameBuffer.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(frameBuffer);
    return;
  }

  // 4. GET /v1/cua/spec: OpenAI CUA tool specification JSON
  if (method === "GET" && pathname === "/v1/cua/spec") {
    const westonStatus = context.weston.getStatus();
    sendJson(res, 200, {
      tool: OPENAI_CUA_TOOL_SPEC,
      display: {
        width: westonStatus.width,
        height: westonStatus.height,
        scale: westonStatus.scale,
        backend: westonStatus.backend,
        environment: "linux",
      },
      endpoints: {
        portal_url: context.portalUrl,
        stream_url: `${context.portalUrl}/v1/cua/stream`,
        live_frame_url: `${context.portalUrl}/v1/cua/live-frame`,
        actions_url: `${context.portalUrl}/v1/cua/actions`,
        session_ws: `${context.portalUrl.replace(/^http/, "ws")}/v1/cua/session`,
        portal_ws: `${context.portalUrl.replace(/^http/, "ws")}/v1/cua/portal`,
      },
    });
    return;
  }

  // 5. GET /v1/cua/screen: Dimensions, Wayland display, status
  if (method === "GET" && pathname === "/v1/cua/screen") {
    const st = context.weston.getStatus();
    sendJson(res, 200, {
      width: st.width,
      height: st.height,
      scale: st.scale,
      wayland_display: st.waylandDisplay,
      pipewire_node: st.pipewireNode,
      status: st.status,
      instance_id: st.instanceId,
      backend: st.backend,
      input_socket: st.inputSocketPath,
      uptime_seconds: st.uptimeSeconds,
    });
    return;
  }

  // 6. POST /v1/cua/actions: Validate with Zod and execute
  if (method === "POST" && pathname === "/v1/cua/actions") {
    try {
      const rawBody = await readJsonBody(req);
      const parseResult = CUAActionsPayloadSchema.safeParse(rawBody);

      if (!parseResult.success) {
        sendJson(res, 400, {
          error: "Invalid CUA action payload",
          details: parseResult.error.format(),
        });
        return;
      }

      const payload = parseResult.data;
      let actions: CUAAction[];
      if ("actions" in payload) {
        actions = payload.actions;
      } else if ("action" in payload && typeof payload.action === "object" && payload.action !== null) {
        actions = [payload.action];
      } else {
        actions = [payload as CUAAction];
      }

      const results: CUAActionResult[] = [];
      for (const act of actions) {
        const resAct = await executeAction(act, context);
        results.push(resAct);
        if (resAct.status === "error") {
          break;
        }
      }

      const allSuccess = results.every((r) => r.status === "success");
      sendJson(res, allSuccess ? 200 : 500, {
        status: allSuccess ? "success" : "error",
        total_actions: results.length,
        results,
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        error: "Action execution failure",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // 7. POST /v1/chat/completions: OpenAI-compatible completions endpoint
  if (method === "POST" && pathname === "/v1/chat/completions") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
      const model = typeof body["model"] === "string" ? body["model"] : "wstn-cua-operator";

      const actionsToRun: CUAAction[] = [];
      const toolCallResults: Array<{ id: string; action: string; result: CUAActionResult }> = [];

      for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as Record<string, unknown>;

        // Check for tool_calls inside assistant messages or user messages
        if (Array.isArray(msgObj["tool_calls"])) {
          for (const tc of msgObj["tool_calls"]) {
            if (!tc || typeof tc !== "object") continue;
            const tcObj = tc as Record<string, unknown>;
            const fn = tcObj["function"] as Record<string, unknown> | undefined;
            if (fn && typeof fn["arguments"] === "string") {
              try {
                const args = JSON.parse(fn["arguments"]);
                const parsed = CUAActionSchema.safeParse(args);
                if (parsed.success) {
                  actionsToRun.push(parsed.data);
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      }

      // If no explicit tool calls in messages, check if last user message content is a JSON action
      if (actionsToRun.length === 0 && messages.length > 0) {
        const lastMsg = messages[messages.length - 1] as Record<string, unknown> | undefined;
        if (lastMsg && typeof lastMsg["content"] === "string") {
          try {
            const parsedContent = JSON.parse(lastMsg["content"]);
            const parsed = CUAActionSchema.safeParse(parsedContent);
            if (parsed.success) {
              actionsToRun.push(parsed.data);
            }
          } catch {
            // Not JSON action, standard prompt
          }
        }
      }

      for (let i = 0; i < actionsToRun.length; i++) {
        const act = actionsToRun[i]!;
        const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
        const resExec = await executeAction(act, context);
        toolCallResults.push({ id: callId, action: act.action, result: resExec });
      }

      const completionId = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
      const nowSec = Math.floor(Date.now() / 1000);

      sendJson(res, 200, {
        id: completionId,
        object: "chat.completion",
        created: nowSec,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: actionsToRun.length > 0
                ? `Executed ${actionsToRun.length} computer_use action(s) successfully.`
                : "wstn-cua server ready. Pass tool_calls with name 'computer_use' to execute desktop actions.",
              tool_calls: toolCallResults.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: "computer_use",
                  arguments: JSON.stringify(tc.result),
                },
              })),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 45,
          completion_tokens: 30,
          total_tokens: 75,
        },
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        error: "Completion processing error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // 8. POST /v1/apps/launch: Launches an application inside Weston
  if (method === "POST" && pathname === "/v1/apps/launch") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      let command: string[] = [];

      if (typeof body["command"] === "string") {
        command = body["command"].trim().split(/\s+/);
      } else if (Array.isArray(body["command"])) {
        command = body["command"].map(String);
      }

      if (command.length === 0) {
        sendJson(res, 400, { error: "Missing or invalid 'command' field" });
        return;
      }

      const child = context.weston.launchApp(command);
      sendJson(res, 200, {
        status: "launched",
        pid: child.pid,
        command,
        wayland_display: context.weston.waylandDisplay,
      });
      return;
    } catch (err) {
      sendJson(res, 500, {
        error: "App launch failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  sendJson(res, 404, { error: "Route not found", path: pathname });
}
