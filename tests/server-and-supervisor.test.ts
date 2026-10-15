import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WebSocket } from "ws";
import { WestonSupervisor } from "../src/compositor/weston-manager.js";
import { WstnCuaServer } from "../src/server/server.js";

describe("WestonSupervisor and WstnCuaServer", () => {
  const TEST_PORT = 18888;
  let supervisor: WestonSupervisor;
  let server: WstnCuaServer;
  let portalUrl: string;

  beforeAll(async () => {
    supervisor = new WestonSupervisor({
      instanceId: "test-inst",
      width: 1280,
      height: 800,
      backend: "headless",
    });

    server = new WstnCuaServer({
      port: TEST_PORT,
      weston: supervisor,
    });

    const res = await server.start();
    portalUrl = res.portalUrl;
  });

  afterAll(async () => {
    await server.stop();
    await supervisor.stop();
  });

  it("should initialize WestonSupervisor with correct configuration", () => {
    const status = supervisor.getStatus();
    expect(status.instanceId).toBe("test-inst");
    expect(status.width).toBe(1280);
    expect(status.height).toBe(800);
    expect(status.scale).toBe(1);
    expect(status.backend).toBe("headless");
    expect(status.waylandDisplay).toBe("wayland-cua-test-inst");
    expect(status.inputSocketPath).toBe("/tmp/wstn-cua-test-inst.sock");
  });

  it("should serve Web Control Center HTML at GET /", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("wstn-cua");
    expect(text).toContain("Interactive Mode");
  });

  it("should serve static app.js at GET /app.js", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const text = await res.text();
    expect(text).toContain("wstn-cua Web Control Center");
  });

  it("should return OpenAI CUA tool specification at GET /v1/cua/spec", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/spec`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tool).toBeDefined();
    expect(data.tool.type).toBe("function");
    expect(data.tool.function.name).toBe("computer_use");
    expect(data.display.width).toBe(1280);
    expect(data.display.height).toBe(800);
    expect(data.endpoints.portal_url).toBe(portalUrl);
    expect(data.endpoints.stream_url).toBe(`${portalUrl}/v1/cua/stream`);
  });

  it("should return screen metadata at GET /v1/cua/screen", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/screen`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.width).toBe(1280);
    expect(data.height).toBe(800);
    expect(data.wayland_display).toBe("wayland-cua-test-inst");
    expect(data.input_socket).toBe("/tmp/wstn-cua-test-inst.sock");
    expect(data.backend).toBe("headless");
  });

  it("should return a valid JPEG buffer at GET /v1/cua/live-frame", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/live-frame`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    expect(buf.length).toBeGreaterThan(10);
    // JPEG magic bytes: FF D8
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("should validate and execute single CUA action at POST /v1/cua/actions", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: {
          action: "click",
          coordinate: [640, 400],
          button: "left",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("success");
    expect(data.total_actions).toBe(1);
    expect(data.results[0].action).toBe("click");
    expect(data.results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("should reject invalid CUA action with 400", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: {
          action: "invalid_action_name",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("should execute multiple actions at POST /v1/cua/actions", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/cua/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actions: [
          { action: "move", coordinate: [100, 100] },
          { action: "type", text: "hello" },
          { action: "wait", duration_ms: 10 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("success");
    expect(data.total_actions).toBe(3);
  });

  it("should process OpenAI chat completions with computer_use tool calls", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: "Click on the terminal",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "computer_use",
                  arguments: JSON.stringify({
                    action: "click",
                    coordinate: [300, 200],
                  }),
                },
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe("chat.completion");
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(data.choices[0].message.tool_calls.length).toBe(1);
  });

  it("should handle full duplex WebSocket on /v1/cua/session", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/v1/cua/session`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.id === "test-ws-call") {
          resolve(msg);
        }
      });
    });

    ws.send(JSON.stringify({
      id: "test-ws-call",
      action: {
        action: "move",
        coordinate: [500, 300],
      },
    }));

    const response = await responsePromise;
    expect(response.id).toBe("test-ws-call");
    expect(response.status).toBe("success");
    expect(response.action).toBe("move");

    ws.close();
  });

  it("should handle portal WebSocket interactions on /v1/cua/portal", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/v1/cua/portal`);

    const initPromise = new Promise<any>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "init") {
          resolve(msg);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const initMsg = await initPromise;
    expect(initMsg.type).toBe("init");
    expect(initMsg.status.width).toBe(1280);

    // Send mouse move interaction
    ws.send(JSON.stringify({
      type: "mouse_move",
      x: 250,
      y: 150,
    }));

    // Wait a brief moment for processing
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
  });
});
