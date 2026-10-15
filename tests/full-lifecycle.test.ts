import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { WestonSupervisor } from '../src/compositor/weston-manager.js';
import { WstnCuaServer } from '../src/server/server.js';
import { WebSocket } from 'ws';

describe('Full Lifecycle Integration Test', () => {
  let supervisor: WestonSupervisor | null = null;
  let server: WstnCuaServer | null = null;
  const testPort = 19876;
  const instanceId = `lifecycle-${Date.now()}`;

  beforeAll(async () => {
    // Initialize Weston in headless mode with our native injector
    supervisor = new WestonSupervisor({
      instanceId,
      backend: 'headless',
      width: 1280,
      height: 800,
      idleTime: 0,
      autoRestart: false,
    });

    await supervisor.start();
    expect(supervisor.getStatus().status).toBe('running');

    // Initialize Server
    server = new WstnCuaServer({
      port: testPort,
      weston: supervisor,
      streamManagerOptions: {
        mode: 'synthetic', // reliably emits frames for integration test
        fps: 30,
        width: 1280,
        height: 800,
      },
    });

    await server.start();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (supervisor) {
      await supervisor.stop();
    }
  });

  it('verifies compositor status and wayland environment', () => {
    expect(supervisor).not.toBeNull();
    expect(supervisor!.waylandDisplay).toContain('wayland-cua-');
    expect(supervisor!.inputSocketPath).toContain('/tmp/wstn-cua-');
    expect(supervisor!.getStatus().status).toBe('running');
  });

  it('fetches screen metadata via GET /v1/cua/screen', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/cua/screen`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.status).toBe('running');
    expect(data.width).toBe(1280);
    expect(data.height).toBe(800);
    expect(data.wayland_display).toContain('wayland-cua-');
  });

  it('fetches OpenAI CUA tool specification via GET /v1/cua/spec', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/cua/spec`);
    expect(res.status).toBe(200);
    const spec = await res.json() as { tool: { type: string; function: { name: string } }; display: { width: number; height: number }; endpoints: { stream_url: string } };
    expect(spec.tool.type).toBe('function');
    expect(spec.tool.function.name).toBe('computer_use');
    expect(spec.display.width).toBe(1280);
    expect(spec.display.height).toBe(800);
    expect(spec.endpoints.stream_url).toContain('/v1/cua/stream');
  });

  it('fetches a live snapshot frame via GET /v1/cua/live-frame', async () => {
    // Wait for frame to be available
    await new Promise((r) => setTimeout(r, 60));
    const res = await fetch(`http://127.0.0.1:${testPort}/v1/cua/live-frame`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(100);
    // Verify JPEG SOI marker
    const view = new Uint8Array(bytes);
    expect(view[0]).toBe(0xff);
    expect(view[1]).toBe(0xd8);
  });

  it('executes a sequence of OpenAI CUA actions via POST /v1/cua/actions', async () => {
    const actions = [
      { action: 'move', coordinate: [300, 400] },
      { action: 'click', coordinate: [300, 400], button: 'left' },
      { action: 'type', text: 'Antigravity CUA' },
      { action: 'keypress', keys: 'Return' },
      { action: 'scroll', delta_y: -100 },
      { action: 'screenshot' },
    ];

    const res = await fetch(`http://127.0.0.1:${testPort}/v1/cua/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    });

    expect(res.status).toBe(200);
    const result = await res.json() as Record<string, unknown>;
    expect(result.status).toBe('success');
    expect(Array.isArray(result.results)).toBe(true);
    const results = result.results as Array<{ status: string; action: string; duration_ms: number }>;
    expect(results.length).toBe(6);
    expect(results[0]?.status).toBe('success');
    expect(results[0]?.action).toBe('move');
    expect(results[5]?.action).toBe('screenshot');
  });

  it('receives live streaming frames over WebSocket on /v1/cua/stream', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/v1/cua/stream`);

    const receivedFrame = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket frame timeout'));
      }, 3000);

      ws.on('message', (data) => {
        const text = data.toString();
        if (text.includes('"type":"frame"')) {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(receivedFrame).toBe(true);
  });

  it('launches an application inside the sandboxed Weston display', async () => {
    expect(supervisor).not.toBeNull();
    // Launch a benign command like 'echo' or 'true' inside the display
    const child = supervisor!.launchApp(['true']);
    expect(child.pid).toBeGreaterThan(0);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    expect(exitCode).toBe(0);
  });
});
