import * as fs from "node:fs";
import * as path from "node:path";
import { WestonSupervisor } from "../compositor/weston-manager.js";
import { WstnCuaServer } from "../server/server.js";

const STATE_FILE = path.join("/tmp", `wstn-cua-state-${process.getuid ? process.getuid() : 1000}.json`);

interface CliState {
  pid: number;
  port: number;
  width: number;
  height: number;
  backend: string;
  waylandDisplay: string;
  inputSocket: string;
  portalUrl: string;
  startedAt: number;
}

function saveState(state: CliState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function loadState(): CliState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw) as CliState;
  } catch {
    return null;
  }
}

function removeState(): void {
  if (fs.existsSync(STATE_FILE)) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // Ignore
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- CLI Commands ---

async function commandStart(args: string[]): Promise<void> {
  let port = 8080;
  let width = 1280;
  let height = 800;
  let backend = "pipewire";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[++i]!, 10);
    } else if (arg === "--width" && args[i + 1]) {
      width = parseInt(args[++i]!, 10);
    } else if (arg === "--height" && args[i + 1]) {
      height = parseInt(args[++i]!, 10);
    } else if (arg === "--headless") {
      backend = "pipewire";
    } else if (arg === "--backend" && args[i + 1]) {
      backend = args[++i]!;
    }
  }

  // Check if an instance is already running
  const existing = loadState();
  if (existing && isProcessAlive(existing.pid)) {
    console.error(`wstn-cua is already running (PID: ${existing.pid}) at ${existing.portalUrl}`);
    process.exit(1);
  }

  console.log(`[wstn-cua] Initializing Weston Supervisor (${backend}, ${width}x${height})...`);
  const supervisor = new WestonSupervisor({
    width,
    height,
    backend,
  });

  try {
    await supervisor.start();
  } catch (err) {
    console.warn(`[wstn-cua] Note: Weston supervisor started with warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  const server = new WstnCuaServer({
    port,
    weston: supervisor,
  });

  const { portalUrl } = await server.start();

  const status = supervisor.getStatus();
  const state: CliState = {
    pid: process.pid,
    port,
    width,
    height,
    backend,
    waylandDisplay: status.waylandDisplay,
    inputSocket: status.inputSocketPath,
    portalUrl,
    startedAt: Date.now(),
  };
  saveState(state);

  console.log(`
┌────────────────────────────────────────────────────────────────────────┐
│                      wstn-cua Supervisor & Portal                      │
├────────────────────────────────────────────────────────────────────────┤
│  Portal Web UI:    ${portalUrl.padEnd(52)}│
│  Wayland Display:  ${status.waylandDisplay.padEnd(52)}│
│  Input Socket:     ${status.inputSocketPath.padEnd(52)}│
│  Resolution:       ${`${width}x${height} (${backend})`.padEnd(52)}│
│                                                                        │
│  MJPEG Stream:     ${`${portalUrl}/v1/cua/stream`.padEnd(52)}│
│  Live Snapshot:    ${`${portalUrl}/v1/cua/live-frame`.padEnd(52)}│
│  OpenAI Spec:      ${`${portalUrl}/v1/cua/spec`.padEnd(52)}│
│  Chat Completions: ${`${portalUrl}/v1/chat/completions`.padEnd(52)}│
└────────────────────────────────────────────────────────────────────────┘
`);

  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[wstn-cua] Stopping server and Weston supervisor...");
    await server.stop();
    await supervisor.stop();
    removeState();
    console.log("[wstn-cua] Stopped cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", () => {
    // Ignore SIGHUP to allow background execution
  });

  // Keep event loop alive
  await new Promise(() => {});
}

async function commandStatus(): Promise<void> {
  const state = loadState();
  if (state && isProcessAlive(state.pid)) {
    try {
      const res = await fetch(`${state.portalUrl}/v1/cua/screen`);
      const screen = await res.json();
      console.log(`wstn-cua is RUNNING (PID: ${state.pid})`);
      console.log(`  Portal URL:       ${state.portalUrl}`);
      console.log(`  Wayland Display:  ${screen.wayland_display || state.waylandDisplay}`);
      console.log(`  Input Socket:     ${screen.input_socket || state.inputSocket}`);
      console.log(`  Resolution:       ${screen.width}x${screen.height}`);
      console.log(`  Backend:          ${screen.backend || state.backend}`);
      console.log(`  Status:           ${screen.status}`);
      console.log(`  Uptime:           ${screen.uptime_seconds || 0}s`);
      return;
    } catch {
      // Fall through
    }
  }

  // Probe localhost:8080 just in case
  try {
    const res = await fetch("http://localhost:8080/v1/cua/screen");
    if (res.ok) {
      const screen = await res.json();
      console.log("wstn-cua is RUNNING on http://localhost:8080");
      console.log(JSON.stringify(screen, null, 2));
      return;
    }
  } catch {
    // Not running
  }

  console.log("wstn-cua is not running.");
}

async function commandRun(commandArgs: string[]): Promise<void> {
  if (commandArgs.length === 0) {
    console.error("Usage: wstn-cua run <command...>");
    process.exit(1);
  }

  const state = loadState();
  const targetPort = state?.port ?? 8080;

  try {
    const res = await fetch(`http://localhost:${targetPort}/v1/apps/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: commandArgs }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`Launched ${commandArgs.join(" ")} (PID: ${data.pid}) on display ${data.wayland_display}`);
      return;
    }
  } catch {
    // If server not reachable, try running directly if waylandDisplay known
    if (state?.waylandDisplay) {
      const { spawn } = await import("node:child_process");
      const cleanEnv = { ...process.env };
      delete cleanEnv["DBUS_SESSION_BUS_ADDRESS"];
      delete cleanEnv["WAYLAND_DISPLAY"];
      delete cleanEnv["DISPLAY"];

      const executable = commandArgs[0]!;
      const execBase = path.basename(executable).toLowerCase();
      const finalArgs = commandArgs.slice(1);
      const isBrowser = execBase.includes("helium") || execBase.includes("chrome") || execBase.includes("chromium") || execBase.includes("brave");
      if (isBrowser) {
        finalArgs.unshift(`--user-data-dir=/tmp/wstn-cua-profile-${state.waylandDisplay}`, "--ozone-platform=wayland", "--no-first-run", "--no-default-browser-check");
      }

      const child = spawn(executable, finalArgs, {
        env: {
          ...cleanEnv,
          WAYLAND_DISPLAY: state.waylandDisplay,
          DISPLAY: ":100",
          XDG_CURRENT_DESKTOP: "Weston",
          XDG_SESSION_TYPE: "wayland",
          GDK_BACKEND: "wayland",
          QT_QPA_PLATFORM: "wayland",
        },
        stdio: "inherit",
      });
      console.log(`Launched ${executable} directly (PID: ${child.pid}) on ${state.waylandDisplay}`);
      return;
    }
  }

  console.error("Failed to launch command: wstn-cua server is not reachable.");
  process.exit(1);
}

async function commandAction(jsonStr: string): Promise<void> {
  if (!jsonStr) {
    console.error("Usage: wstn-cua action '<json>'");
    process.exit(1);
  }

  let actionObj: unknown;
  try {
    actionObj = JSON.parse(jsonStr);
  } catch (err) {
    console.error("Invalid JSON string:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const state = loadState();
  const targetPort = state?.port ?? 8080;

  try {
    const t0 = performance.now();
    const res = await fetch(`http://localhost:${targetPort}/v1/cua/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionObj),
    });

    const data = await res.json();
    const elapsed = Math.round(performance.now() - t0);
    console.log(`Response (${elapsed}ms):`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to send action:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function commandStop(): Promise<void> {
  const state = loadState();
  if (!state) {
    console.log("No running wstn-cua instance found.");
    return;
  }

  if (isProcessAlive(state.pid)) {
    console.log(`Stopping wstn-cua instance (PID: ${state.pid})...`);
    try {
      process.kill(state.pid, "SIGTERM");
      let waited = 0;
      while (isProcessAlive(state.pid) && waited < 3000) {
        await new Promise((r) => setTimeout(r, 200));
        waited += 200;
      }
      if (isProcessAlive(state.pid)) {
        process.kill(state.pid, "SIGKILL");
      }
    } catch {
      // Ignore
    }
  }

  removeState();
  console.log("wstn-cua stopped.");
}

async function commandView(): Promise<void> {
  const state = loadState();
  const port = state?.port ?? 7860;
  const streamUrl = `http://localhost:${port}/v1/cua/stream`;
  const portalUrl = `http://localhost:${port}`;

  const { spawn, execSync } = await import("node:child_process");

  let hasMpv = false;
  try {
    execSync("which mpv", { stdio: "ignore" });
    hasMpv = true;
  } catch {
    hasMpv = false;
  }

  if (hasMpv) {
    console.log(`[wstn-cua] Opening floating Picture-in-Picture virtual monitor viewer via mpv...`);
    spawn("mpv", [
      streamUrl,
      "--title=wstn-cua: Agent Virtual Monitor",
      "--geometry=640x400-20-20",
      "--no-input-default-bindings",
      "--ontop",
    ], { stdio: "ignore", detached: true });
  } else {
    console.log(`[wstn-cua] Opening web portal in default browser: ${portalUrl}`);
    spawn("xdg-open", [portalUrl], { stdio: "ignore", detached: true });
  }
}

function printHelp(): void {
  console.log(`
wstn-cua: Weston Wayland Compositor Supervisor & CUA Portal CLI

Usage:
  wstn-cua start [--port <n>] [--width <w>] [--height <h>] [--headless] [--backend <bkg>]
  wstn-cua run <command...>
  wstn-cua view
  wstn-cua status
  wstn-cua action '<json>'
  wstn-cua stop
  wstn-cua help
`);
}

// --- Entry Point ---

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];

  switch (cmd) {
    case "start":
      await commandStart(argv.slice(1));
      break;
    case "run":
      await commandRun(argv.slice(1));
      break;
    case "view":
      await commandView();
      break;
    case "status":
      await commandStatus();
      break;
    case "action":
      await commandAction(argv[1] ?? "");
      break;
    case "stop":
      await commandStop();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[wstn-cua Fatal Error]", err);
    process.exit(1);
  });
}
