import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WestonSupervisor } from "../compositor/weston-manager.js";
import { StreamManager } from "../portal/stream-manager.js";
import { ActionExecutor } from "../cua/action-executor.js";
import {
  handleHttpRequest,
  executeAction,
  FALLBACK_JPEG_BUFFER,
  CUAActionSchema,
  type ServerContext,
  type StreamManagerInterface,
  type ActionExecutorInterface,
  type CUAActionResult,
  type CUAAction,
} from "./routes.js";

export interface WstnServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly weston?: WestonSupervisor;
  readonly streamManager?: StreamManagerInterface | undefined;
  readonly actionExecutor?: ActionExecutorInterface | undefined;
}

export class WstnCuaServer {
  private readonly port: number;
  private readonly host: string;
  private readonly weston: WestonSupervisor;
  private readonly streamManager?: StreamManagerInterface | undefined;
  private readonly actionExecutor?: ActionExecutorInterface | undefined;
  private readonly recentAgentActions: CUAActionResult[] = [];

  private httpServer: http.Server | null = null;
  private sessionWss: WebSocketServer | null = null;
  private portalWss: WebSocketServer | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private frameInterval: NodeJS.Timeout | null = null;
  private frameCounter = 0;

  constructor(options: WstnServerOptions = {}) {
    this.port = options.port ?? 8080;
    this.host = options.host ?? "0.0.0.0";
    this.weston = options.weston ?? new WestonSupervisor();
    this.streamManager = options.streamManager ?? new StreamManager({
      mode: "auto",
      targetNode: this.weston.pipewireNode,
      width: this.weston.width,
      height: this.weston.height,
      fps: 30,
    });
    this.actionExecutor = options.actionExecutor ?? new ActionExecutor({
      socketPath: this.weston.inputSocketPath,
      screenWidth: this.weston.width,
      screenHeight: this.weston.height,
    });
  }

  public getContext(): ServerContext {
    const portalUrl = `http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}`;
    return {
      weston: this.weston,
      streamManager: this.streamManager,
      actionExecutor: this.actionExecutor,
      portalUrl,
      port: this.port,
      recentAgentActions: this.recentAgentActions,
      onActionExecuted: (action, result) => {
        if (!this.portalWss) return;
        const payload = JSON.stringify({
          type: "agent_action",
          action,
          result,
          timestamp: Date.now(),
        });
        for (const client of this.portalWss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      },
    };
  }

  public async start(): Promise<{ port: number; portalUrl: string }> {
    const context = this.getContext();

    // Start stream ingestion
    if (this.streamManager && "start" in this.streamManager && typeof this.streamManager.start === "function") {
      try {
        await this.streamManager.start();
      } catch (err) {
        console.warn(`[wstn-cua] StreamManager start warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 1. Create HTTP Server
    this.httpServer = http.createServer(async (req, res) => {
      try {
        await handleHttpRequest(req, res, context);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error", message: String(err) }));
        }
      }
    });

    // 2. Create WebSocket Servers (noServer: true to route by URL)
    this.sessionWss = new WebSocketServer({ noServer: true });
    this.portalWss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      const { pathname } = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (pathname === "/v1/cua/session" || pathname === "/v1/cua/stream") {
        this.sessionWss?.handleUpgrade(request, socket, head, (ws) => {
          this.sessionWss?.emit("connection", ws, request);
        });
      } else if (pathname === "/v1/cua/portal") {
        this.portalWss?.handleUpgrade(request, socket, head, (ws) => {
          this.portalWss?.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Setup Agent Session WS
    this.sessionWss.on("connection", (ws: WebSocket) => {
      ws.on("message", async (data: Buffer | string) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf8");
          const parsed = JSON.parse(raw);
          const actionData = parsed.action ?? parsed;
          const actionResult = CUAActionSchema.safeParse(actionData);

          if (!actionResult.success) {
            ws.send(JSON.stringify({
              id: parsed.id,
              status: "error",
              error: "Invalid CUA action",
              details: actionResult.error.format(),
            }));
            return;
          }

          const execResult = await executeAction(actionResult.data, context);
          ws.send(JSON.stringify({
            id: parsed.id,
            ...execResult,
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      });
    });

    // Setup Portal Web UI WS
    this.portalWss.on("connection", (ws: WebSocket) => {
      // Send initial state
      const st = this.weston.getStatus();
      ws.send(JSON.stringify({
        type: "init",
        status: st,
        recentActions: this.recentAgentActions.slice(0, 20),
      }));

      ws.on("message", async (data: Buffer | string) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf8");
          const msg = JSON.parse(raw) as Record<string, unknown>;
          const msgType = String(msg["type"] ?? "");

          if (msgType === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }

          if (msgType === "launch_app") {
            const cmd = msg["command"];
            if (typeof cmd === "string") {
              this.weston.launchApp(cmd.trim().split(/\s+/));
            } else if (Array.isArray(cmd)) {
              this.weston.launchApp(cmd.map(String));
            }
            return;
          }

          // Remote desktop interactions forwarded directly
          let actionToRun: CUAAction | null = null;
          if (msgType === "mouse_move") {
            const x = Number(msg["x"] ?? 0);
            const y = Number(msg["y"] ?? 0);
            actionToRun = { action: "move", coordinate: [x, y] };
          } else if (msgType === "mouse_down") {
            const x = Number(msg["x"] ?? 0);
            const y = Number(msg["y"] ?? 0);
            const btn = (msg["button"] as "left" | "right" | "middle") ?? "left";
            actionToRun = { action: "mouse_down", button: btn, coordinate: [x, y] };
          } else if (msgType === "mouse_up") {
            const x = Number(msg["x"] ?? 0);
            const y = Number(msg["y"] ?? 0);
            const btn = (msg["button"] as "left" | "right" | "middle") ?? "left";
            actionToRun = { action: "mouse_up", button: btn, coordinate: [x, y] };
          } else if (msgType === "click") {
            const x = Number(msg["x"] ?? 0);
            const y = Number(msg["y"] ?? 0);
            const btn = (msg["button"] as "left" | "right" | "middle") ?? "left";
            actionToRun = { action: "click", coordinate: [x, y], button: btn };
          } else if (msgType === "scroll") {
            const deltaX = Number(msg["deltaX"] ?? 0);
            const deltaY = Number(msg["deltaY"] ?? 0);
            actionToRun = { action: "scroll", delta_x: deltaX, delta_y: deltaY };
          } else if (msgType === "type") {
            const text = String(msg["text"] ?? "");
            actionToRun = { action: "type", text };
          } else if (msgType === "key_down") {
            const key = String(msg["key"] ?? "");
            actionToRun = { action: "key_down", key };
          } else if (msgType === "key_up") {
            const key = String(msg["key"] ?? "");
            actionToRun = { action: "key_up", key };
          } else if (msgType === "keypress") {
            const keys = (msg["keys"] as string | string[]) ?? "Return";
            actionToRun = { action: "keypress", keys };
          }

          if (actionToRun) {
            await executeAction(actionToRun, context);
          }
        } catch {
          // Ignore portal message parse errors
        }
      });
    });

    // Start background frame distribution to session WS clients
    this.frameInterval = setInterval(() => {
      if (!this.sessionWss || this.sessionWss.clients.size === 0) return;

      this.frameCounter++;
      let frameBuffer: Buffer = FALLBACK_JPEG_BUFFER;
      if (this.streamManager) {
        const latest = this.streamManager.getLatestFrame();
        if (latest) {
          frameBuffer = Buffer.from(latest.buffer);
        }
      }

      const framePayload = JSON.stringify({
        type: "frame",
        frameId: this.frameCounter,
        timestamp: Date.now(),
        image: `data:image/jpeg;base64,${frameBuffer.toString("base64")}`,
      });

      for (const client of this.sessionWss.clients) {
        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024 * 1024) {
          client.send(framePayload);
        }
      }
    }, 100);

    // Periodic status updates to Portal Web clients
    this.statsInterval = setInterval(() => {
      if (!this.portalWss || this.portalWss.clients.size === 0) return;

      const st = this.weston.getStatus();
      const statsPayload = JSON.stringify({
        type: "stats",
        status: st,
        recentActions: this.recentAgentActions.slice(0, 10),
        timestamp: Date.now(),
      });

      for (const client of this.portalWss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(statsPayload);
        }
      }
    }, 1000);

    // Listen on port
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.listen(this.port, this.host, () => {
        resolve();
      });
      this.httpServer?.on("error", reject);
    });

    return {
      port: this.port,
      portalUrl: context.portalUrl,
    };
  }

  public async stop(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }

    if (this.sessionWss) {
      for (const client of this.sessionWss.clients) {
        client.terminate();
      }
      this.sessionWss.close();
      this.sessionWss = null;
    }

    if (this.portalWss) {
      for (const client of this.portalWss.clients) {
        client.terminate();
      }
      this.portalWss.close();
      this.portalWss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }

    if (this.streamManager && "stop" in this.streamManager && typeof this.streamManager.stop === "function") {
      try {
        await this.streamManager.stop();
      } catch {
        // ignore
      }
    }

    if (this.actionExecutor && "disconnect" in this.actionExecutor && typeof this.actionExecutor.disconnect === "function") {
      try {
        await this.actionExecutor.disconnect();
      } catch {
        // ignore
      }
    }
  }
}
