import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export type WestonBackend = "pipewire" | "headless" | "wayland" | "x11" | "drm";

export type WestonState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

export interface WestonSupervisorOptions {
  readonly instanceId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  readonly backend?: WestonBackend | (string & {});
  readonly injectorModulePath?: string;
  readonly socketName?: string;
  readonly inputSocketPath?: string;
  readonly xwayland?: boolean;
  readonly xwaylandDisplay?: string;
  readonly readyTimeoutMs?: number;
  readonly logCallback?: ((line: string, source: "stdout" | "stderr") => void) | undefined;
}

export interface WestonStatus {
  readonly instanceId: string;
  readonly status: WestonState;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly backend: string;
  readonly waylandDisplay: string;
  readonly inputSocketPath: string;
  readonly xwaylandDisplay: string;
  readonly pipewireNode: string;
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly uptimeSeconds: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_SCALE = 1;
const DEFAULT_BACKEND: WestonBackend = "pipewire";
const DEFAULT_READY_TIMEOUT_MS = 6000;
const MAX_LOG_HISTORY = 500;

export class WestonSupervisor {
  public readonly instanceId: string;
  public readonly width: number;
  public readonly height: number;
  public readonly scale: number;
  public readonly backend: string;
  public readonly waylandDisplay: string;
  public readonly inputSocketPath: string;
  public readonly xwaylandDisplay: string;
  public readonly pipewireNode: string;

  private state: WestonState = "idle";
  private process: ChildProcess | null = null;
  private readonly childProcesses = new Set<ChildProcess>();
  private readonly logs: Array<{ readonly line: string; readonly source: "stdout" | "stderr"; readonly timestamp: number }> = [];
  private startedAt: number | null = null;
  private readonly readyTimeoutMs: number;
  private readonly injectorModulePath: string | null;
  private readonly logCallback?: ((line: string, source: "stdout" | "stderr") => void) | undefined;

  constructor(options: WestonSupervisorOptions = {}) {
    const rawId = options.instanceId ?? Math.random().toString(36).slice(2, 8);
    this.instanceId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
    this.width = options.width ?? DEFAULT_WIDTH;
    this.height = options.height ?? DEFAULT_HEIGHT;
    this.scale = options.scale ?? DEFAULT_SCALE;
    this.backend = options.backend ?? DEFAULT_BACKEND;
    this.waylandDisplay = options.socketName ?? `wayland-cua-${this.instanceId}`;
    this.inputSocketPath = options.inputSocketPath ?? `/tmp/wstn-cua-${this.instanceId}.sock`;
    this.xwaylandDisplay = options.xwaylandDisplay ?? ":100";
    this.pipewireNode = "weston.pipewire";
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.logCallback = options.logCallback;

    this.injectorModulePath = this.resolveInjectorModule(options.injectorModulePath);
  }

  private resolveInjectorModule(explicitPath?: string): string | null {
    if (explicitPath && fs.existsSync(explicitPath)) {
      return path.resolve(explicitPath);
    }

    const candidatePaths = [
      path.resolve(process.cwd(), "src/native/libwstn_injector.so"),
      path.resolve(process.cwd(), "dist/native/libwstn_injector.so"),
      path.resolve(process.cwd(), "libwstn_injector.so"),
      "/usr/local/lib/libwstn_injector.so",
      "/usr/lib/libwstn_injector.so",
    ];

    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return explicitPath ?? null;
  }

  public getStatus(): WestonStatus {
    const now = Date.now();
    const uptime = this.startedAt !== null && this.state === "running"
      ? Math.floor((now - this.startedAt) / 1000)
      : 0;

    return {
      instanceId: this.instanceId,
      status: this.state,
      width: this.width,
      height: this.height,
      scale: this.scale,
      backend: this.backend,
      waylandDisplay: this.waylandDisplay,
      inputSocketPath: this.inputSocketPath,
      xwaylandDisplay: this.xwaylandDisplay,
      pipewireNode: this.pipewireNode,
      pid: this.process?.pid ?? null,
      startedAt: this.startedAt,
      uptimeSeconds: uptime,
    };
  }

  public getRecentLogs(limit: number = 100): ReadonlyArray<{ readonly line: string; readonly source: "stdout" | "stderr"; readonly timestamp: number }> {
    return this.logs.slice(-Math.min(limit, this.logs.length));
  }

  public async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    this.state = "starting";
    this.cleanupSocketFiles();

    const runtimeDir = process.env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid ? process.getuid() : 1000}`;
    if (!fs.existsSync(runtimeDir)) {
      try {
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      } catch {
        // Ignored if cannot create; system or user will manage
      }
    }

    const westonArgs: string[] = [
      `--backend=${this.backend}`,
      `--width=${this.width}`,
      `--height=${this.height}`,
      `--socket=${this.waylandDisplay}`,
      "--idle-time=0",
    ];

    const modules: string[] = [];
    if (this.injectorModulePath && fs.existsSync(this.injectorModulePath)) {
      modules.push(this.injectorModulePath);
    }

    if (modules.length > 0) {
      westonArgs.push(`--modules=${modules.join(",")}`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      WSTN_CUA_SOCK: this.inputSocketPath,
      WAYLAND_DISPLAY: this.waylandDisplay,
      DISPLAY: this.xwaylandDisplay,
      PIPEWIRE_NODE_NAME: this.pipewireNode,
    };

    this.appendLog(`Starting weston with: weston ${westonArgs.join(" ")}`, "stdout");

    const westonProc = spawn("weston", westonArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = westonProc;

    westonProc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.appendLog(text, "stdout");
    });

    westonProc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.appendLog(text, "stderr");
    });

    westonProc.on("exit", (code, signal) => {
      this.appendLog(`Weston process exited with code=${code} signal=${signal}`, "stderr");
      this.state = "stopped";
      this.process = null;
      this.cleanupSocketFiles();
    });

    westonProc.on("error", (err) => {
      this.appendLog(`Failed to start weston: ${err.message}`, "stderr");
      this.state = "error";
    });

    try {
      await this.waitForReady(westonProc);
      this.state = "running";
      this.startedAt = Date.now();
      this.appendLog(`Weston compositor is ready on ${this.waylandDisplay}`, "stdout");
    } catch (error) {
      this.state = "error";
      await this.stop();
      throw error;
    }
  }

  private appendLog(text: string, source: "stdout" | "stderr"): void {
    const lines = text.split("\n");
    const now = Date.now();
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.logs.push({ line: trimmed, source, timestamp: now });
      if (this.logs.length > MAX_LOG_HISTORY) {
        this.logs.shift();
      }
      this.logCallback?.(trimmed, source);
    }
  }

  private async waitForReady(proc: ChildProcess): Promise<void> {
    const startTime = Date.now();
    const runtimeDir = process.env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid ? process.getuid() : 1000}`;
    const waylandSocketFile = path.join(runtimeDir, this.waylandDisplay);

    while (Date.now() - startTime < this.readyTimeoutMs) {
      if (proc.exitCode !== null || proc.killed) {
        throw new Error(`Weston process exited prematurely with code ${proc.exitCode}`);
      }

      // Check 1: If input socket exists and responds
      if (fs.existsSync(this.inputSocketPath)) {
        const socketReady = await this.probeUnixSocket(this.inputSocketPath);
        if (socketReady) {
          return;
        }
      }

      // Check 2: If injector module is not yet compiled or active, check wayland socket
      if (fs.existsSync(waylandSocketFile)) {
        const waylandReady = await this.probeUnixSocket(waylandSocketFile);
        if (waylandReady) {
          // If native injector is present, give a small grace period for its socket to bind
          if (this.injectorModulePath && fs.existsSync(this.injectorModulePath)) {
            if (fs.existsSync(this.inputSocketPath)) {
              return;
            }
          } else {
            return;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If timeout reached but process is running without error, log warning instead of crashing
    if (proc.exitCode === null && (fs.existsSync(waylandSocketFile) || fs.existsSync(this.inputSocketPath))) {
      return;
    }

    throw new Error(
      `Weston supervisor timed out after ${this.readyTimeoutMs}ms waiting for socket ready (${this.waylandDisplay} / ${this.inputSocketPath})`
    );
  }

  private probeUnixSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = net.createConnection({ path: socketPath });
      let resolved = false;

      const finish = (result: boolean) => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          resolve(result);
        }
      };

      client.setTimeout(250);
      client.on("connect", () => finish(true));
      client.on("error", () => finish(false));
      client.on("timeout", () => finish(false));
    });
  }

  public launchApp(command: string[], options: SpawnOptions = {}): ChildProcess {
    if (command.length === 0) {
      throw new Error("Cannot launch empty command array");
    }

    let executable = command[0];
    if (!executable) {
      throw new Error("Executable name missing");
    }

    if (executable === "browser" || executable === "web-browser") {
      const candidates = [
        "/home/radhey/.local/bin/helium-browser",
        "/home/radhey/.local/bin/google-chrome",
        "helium-browser",
        "google-chrome",
        "chromium",
        "firefox",
      ];
      for (const cand of candidates) {
        if (cand.startsWith("/") ? fs.existsSync(cand) : true) {
          executable = cand;
          break;
        }
      }
    }

    const execBase = path.basename(executable).toLowerCase();
    const isChromiumBased = execBase.includes("helium") ||
                            execBase.includes("chrome") ||
                            execBase.includes("chromium") ||
                            execBase.includes("brave") ||
                            execBase.includes("edge");
    const isFirefox = execBase.includes("firefox") || execBase.includes("librewolf");

    const finalArgs = command.slice(1);
    const profileDir = path.join("/tmp", `wstn-cua-profile-${this.instanceId}`);

    if (isChromiumBased) {
      if (!finalArgs.some(a => a.startsWith("--user-data-dir="))) {
        try {
          fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        } catch {
          // ignore
        }
        finalArgs.unshift(`--user-data-dir=${profileDir}`);
      }
      if (!finalArgs.includes("--ozone-platform=wayland")) {
        finalArgs.unshift("--ozone-platform=wayland");
      }
      if (!finalArgs.includes("--no-first-run")) {
        finalArgs.unshift("--no-first-run");
      }
      if (!finalArgs.includes("--no-default-browser-check")) {
        finalArgs.unshift("--no-default-browser-check");
      }
    } else if (isFirefox) {
      if (!finalArgs.includes("--no-remote")) {
        finalArgs.unshift("--no-remote");
      }
      if (!finalArgs.some(a => a === "--profile" || a === "-P")) {
        const ffProfile = path.join(profileDir, "firefox");
        try {
          fs.mkdirSync(ffProfile, { recursive: true, mode: 0o700 });
        } catch {
          // ignore
        }
        finalArgs.unshift("--profile", ffProfile);
      }
    }

    const runtimeDir = process.env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid ? process.getuid() : 1000}`;
    const baseEnv = { ...process.env };
    // CRITICAL: Strip host desktop references so the child process cannot leak to the host screen
    delete baseEnv["DBUS_SESSION_BUS_ADDRESS"]; // prevents single-instance browser IPC from waking the host browser!
    delete baseEnv["WAYLAND_DISPLAY"];
    delete baseEnv["DISPLAY"];

    const mergedEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      XDG_RUNTIME_DIR: runtimeDir,
      WAYLAND_DISPLAY: this.waylandDisplay,
      DISPLAY: this.xwaylandDisplay,
      XDG_CURRENT_DESKTOP: "Weston",
      XDG_SESSION_TYPE: "wayland",
      GDK_BACKEND: "wayland",
      QT_QPA_PLATFORM: "wayland",
      MOZ_ENABLE_WAYLAND: "1",
      ...options.env,
    };

    const child = spawn(executable, finalArgs, {
      ...options,
      env: mergedEnv,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });

    this.childProcesses.add(child);

    child.on("error", (err) => {
      this.childProcesses.delete(child);
      this.appendLog(`App launch error for ${executable}: ${err.message}`, "stderr");
    });

    child.on("exit", () => {
      this.childProcesses.delete(child);
    });

    this.appendLog(`Launched sandboxed app: ${executable} ${finalArgs.join(" ")} (PID: ${child.pid})`, "stdout");
    return child;
  }

  public async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "idle") {
      this.cleanupSocketFiles();
      return;
    }

    this.state = "stopping";
    this.appendLog("Stopping Weston compositor supervisor...", "stdout");

    // 1. Terminate all child applications
    for (const child of this.childProcesses) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }

    // Allow apps 500ms to exit gracefully
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const child of this.childProcesses) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
    }
    this.childProcesses.clear();

    // 2. Terminate Weston
    const westonProc = this.process;
    if (westonProc && westonProc.exitCode === null && !westonProc.killed) {
      westonProc.kill("SIGTERM");

      const exited = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        westonProc.once("exit", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

      if (!exited && westonProc.exitCode === null) {
        westonProc.kill("SIGKILL");
      }
    }

    this.process = null;
    this.state = "stopped";
    this.cleanupSocketFiles();
    this.appendLog("Weston compositor supervisor stopped cleanly.", "stdout");
  }

  private cleanupSocketFiles(): void {
    if (fs.existsSync(this.inputSocketPath)) {
      try {
        fs.unlinkSync(this.inputSocketPath);
      } catch {
        // Ignore
      }
    }

    const runtimeDir = process.env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid ? process.getuid() : 1000}`;
    const waylandSocketFile = path.join(runtimeDir, this.waylandDisplay);
    if (fs.existsSync(waylandSocketFile)) {
      try {
        fs.unlinkSync(waylandSocketFile);
      } catch {
        // Ignore
      }
    }
    const waylandSocketLock = `${waylandSocketFile}.lock`;
    if (fs.existsSync(waylandSocketLock)) {
      try {
        fs.unlinkSync(waylandSocketLock);
      } catch {
        // Ignore
      }
    }
  }
}
