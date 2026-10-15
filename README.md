# wstn-cua: Weston Compositor & Live Portal for OpenAI Computer Use Agents (CUA)

`wstn-cua` is a standalone Linux application that binds the [Weston Wayland reference compositor](https://gitlab.freedesktop.org/wayland/weston) into an isolated, high-performance sandbox and exposes a real-time live streaming portal and OpenAI-compliant Computer Use Agent (CUA) interface.

Any Linux user can install `wstn-cua` on their laptop to immediately get sandboxed, zero-latency computer use access for autonomous AI agents without giving up control of their personal desktop.

---

## Key Features

- **Isolated Weston Display Sandbox**: Spawns an isolated Wayland display (`wayland-cua-*`, with optional Xwayland `:100`) so agents operate in their own virtual space without stealing your hardware mouse, keyboard focus, or modifying your active session.
- **Sub-Millisecond Native C Input Injection**: Includes `libwstn_injector.so`, a native libweston C module that registers a virtual Wayland seat directly in the compositor event loop, handling absolute motions, button clicks, drags, scrolls, and keycodes over a local UNIX domain socket.
- **Live Video Feed via PipeWire & Portals (Not Slow Screenshots)**:
  - Weston streams outputs directly to PipeWire (`weston.pipewire`).
  - Native `pw_stream` grabber captures uncompressed video buffers with zero copy.
  - HTTP Multipart MJPEG stream (`/v1/cua/stream`) allows any browser, dashboard, or agent to watch live 30/60 FPS video.
  - WebRTC WHEP signaling endpoints (`/v1/cua/whep`, JSON offer/ICE/close). Signaling only today; the media transport is not wired up yet.
  - Atomic zero-latency snapshot buffer (`/v1/cua/live-frame`) for instant frame retrieval (<1ms).
- **OpenAI CUA Specification Compliant**:
  - Full implementation of OpenAI's Computer Use Agent specification (`type: "computer_use"`).
  - Strongly typed Zod schemas for all actions: `click`, `double_click`, `triple_click`, `middle_click`, `right_click`, `mouse_down`, `mouse_up`, `move`, `drag`, `type`, `keypress`, `key_down`, `key_up`, `scroll`, `wait`, `screenshot`.
  - Comprehensive Linux `evdev` keycode mapping (`<linux/input-event-codes.h>`) supporting complex combos (e.g. `ctrl+shift+t`, `alt+f4`) and text decomposition with Shift modifier tracking.
  - OpenAI `/v1/chat/completions` compatibility proxy executing model tool calls on the sandboxed desktop.
- **Interactive Dark-Themed Web Control Center**:
  - Live desktop canvas view with visual action overlay (animating agent clicks in real-time).
  - Interactive Remote Mode: forward mouse moves, clicks, and keystrokes directly from the browser.
  - One-click app launcher (launch Chromium, Firefox, Terminal, or custom binaries inside the sandbox).
  - Real-time agent console, manual action tester, and live FPS / latency telemetry.

---

## Architecture Overview

```text
+-----------------------------------------------------------------------------------+
|                                  WSTN-CUA APP                                     |
|                                                                                   |
|  +------------------------+             +---------------------------------------+ |
|  |   Weston Compositor    |             |          CUA Gateway Server           | |
|  |  (pipewire-backend or  |             |          (Bun / Node / TS)            | |
|  |   headless+pipewire)   |             |                                       | |
|  |                        |             |  +---------------------------------+  | |
|  |  +------------------+  | Unix Socket |  | OpenAI CUA API Engine           |  | |
|  |  | wstn_injector.so |<-|-------------|--| - POST /v1/cua/actions          |  | |
|  |  |  (C Plugin)      |  |             |  | - POST /v1/chat/completions     |  | |
|  |  +------------------+  |             |  | - WS   /v1/cua/session          |  | |
|  +-----------|------------+             |  +---------------------------------+  | |
|              | PipeWire Node            |  +---------------------------------+  | |
|              | (weston.pipewire)        |  | Portal & Live Stream Engine     |  | |
|              v                          |  | - GET  /v1/cua/stream (MJPEG)   |  | |
|  +------------------------+             |  | - GET  /v1/cua/live-frame (JPEG)|  | |
|  |    PipeWire Daemon     |<------------|--| - WebRTC WHEP Protocol Signaling|  | |
|  +------------------------+             |  | - XDG Desktop Portal Discovery  |  | |
|                                         |  +---------------------------------+  | |
|                                         |  +---------------------------------+  | |
|                                         |  | Web Control Center UI           |  | |
|                                         |  | - http://localhost:8080/        |  | |
|                                         +--+---------------------------------+--+ |
+-----------------------------------------------------------------------------------+
```

---

## Quick Start & Installation

### Requirements
- Linux (x86_64 or aarch64)
- `weston` (tested with 15.x; the build must include the PipeWire backend, `pipewire-backend.so`)
- `pipewire` (Multimedia server)
- `gcc` and `pkg-config` (for native injector compilation)
- `bun` or `node` (>= 18)

On NixOS:
```bash
nix develop
```
The dev shell provides weston, pipewire, the C toolchain, and bun. The flake pins nixpkgs to the stable 26.05 branch on purpose: weston 16 in nixpkgs unstable marks the PipeWire backend deprecated and ships without it.

On Arch / CachyOS / Manjaro:
```bash
sudo pacman -S weston pipewire gcc pkg-config
```

On Ubuntu / Debian:
```bash
sudo apt-get install weston pipewire libpipewire-0.3-dev libweston-dev gcc pkg-config
```

On Fedora:
```bash
sudo dnf install weston pipewire pipewire-devel libweston-devel gcc pkgconf
```

### Installation

Clone and run the installer:
```bash
./install.sh
```
Or build manually:
```bash
make
```

This compiles the native C modules (`libwstn_injector.so` and `pw_stream`), type-checks TypeScript sources, and symlinks `bin/wstn-cua` to `~/.local/bin/wstn-cua`.

---

## Usage

### 1. Starting the Sandbox
Start the Weston supervisor and CUA gateway:
```bash
wstn-cua start
```
Options:
```bash
wstn-cua start --port 8080 --width 1280 --height 800
```
- `--port <number>`: Gateway port (default: `8080`).
- `--width <number>`: Viewport width (default: `1280`).
- `--height <number>`: Viewport height (default: `800`).
- `--backend <name>`: Weston backend (default: `pipewire`).
  - `pipewire`: offscreen compositor that screencasts straight into PipeWire. This is what feeds the live video feed.
  - `headless`: offscreen compositor without a PipeWire output; the stream falls back to synthetic frames.
  - `wayland` / `x11`: nested window on your current desktop, so you can watch the sandbox live on screen.

Open **http://localhost:8080** in your browser to access the Web Control Center!

### 2. Launching Applications Inside the Sandbox
Launch any desktop application (browsers, terminals, text editors) directly inside the sandboxed Weston display:
```bash
wstn-cua run firefox
# or
wstn-cua run chromium --no-sandbox
# or
wstn-cua run weston-terminal
```

### 3. Executing CUA Actions via CLI
Send immediate OpenAI CUA actions:
```bash
wstn-cua action '{"action":"click","coordinate":[400,300]}'
wstn-cua action '{"action":"type","text":"Hello from CUA!"}'
wstn-cua action '{"action":"keypress","keys":"ctrl+shift+t"}'
```

### 4. Viewing the Agent's Virtual Monitor
You can keep working on your laptop without interruption while the agent works on its isolated virtual monitor. To peek at what the agent is doing:
- **Web Portal**: Visit `http://localhost:8080` in any browser.
- **Picture-in-Picture Floating Window**:
  ```bash
  wstn-cua view
  ```
  Opens an untracked, non-interactive floating viewer window via `mpv` so you can monitor the agent in real time without stealing your mouse or keyboard focus!

### 5. Checking Status & Stopping
```bash
wstn-cua status
wstn-cua stop
```

---

## API Reference

### 1. OpenAI CUA Tool Specification: `GET /v1/cua/spec`
Returns the standard OpenAI tool declaration schema:
```json
{
  "tool": {
    "type": "function",
    "function": {
      "name": "computer_use",
      "description": "Execute mouse, keyboard, and desktop actions in the sandboxed Weston Wayland desktop environment.",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": ["click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move", "drag", "type", "keypress", "key_down", "key_up", "scroll", "wait", "screenshot"]
          },
          "coordinate": { "type": "array", "items": { "type": "integer" } },
          "button": { "type": "string", "enum": ["left", "right", "middle"] },
          "text": { "type": "string" },
          "keys": { "type": "string" },
          "delta_x": { "type": "number" },
          "delta_y": { "type": "number" }
        },
        "required": ["action"]
      }
    }
  },
  "display": { "width": 1280, "height": 800, "scale": 1, "backend": "pipewire", "environment": "linux" },
  "endpoints": {
    "portal_url": "http://localhost:8080",
    "stream_url": "http://localhost:8080/v1/cua/stream",
    "live_frame_url": "http://localhost:8080/v1/cua/live-frame",
    "actions_url": "http://localhost:8080/v1/cua/actions",
    "session_ws": "ws://localhost:8080/v1/cua/session",
    "portal_ws": "ws://localhost:8080/v1/cua/portal"
  }
}
```

### 2. Live Video Feed: `GET /v1/cua/stream`
Continuous multipart MJPEG stream (`Content-Type: multipart/x-mixed-replace; boundary=frame`).
Display in any browser or HTML viewer:
```html
<img src="http://localhost:8080/v1/cua/stream" alt="Live Weston Desktop" />
```

### 3. Instant Snapshot: `GET /v1/cua/live-frame`
Returns the freshest JPEG frame (`Content-Type: image/jpeg`) directly from the zero-latency in-memory buffer with sub-millisecond retrieval latency.

### 4. Execute Actions: `POST /v1/cua/actions`
Execute single or batched actions:
```json
{
  "actions": [
    { "action": "move", "coordinate": [500, 300] },
    { "action": "click", "coordinate": [500, 300], "button": "left" },
    { "action": "type", "text": "Search query" },
    { "action": "keypress", "keys": "Return" }
  ]
}
```
Response:
```json
{
  "status": "success",
  "results": [
    { "status": "success", "action": "move", "duration_ms": 1.2 },
    { "status": "success", "action": "click", "duration_ms": 42.1 },
    { "status": "success", "action": "type", "duration_ms": 28.5 },
    { "status": "success", "action": "keypress", "duration_ms": 15.3 }
  ]
}
```

### 5. OpenAI Chat Completions Proxy: `POST /v1/chat/completions`
Compatible with standard OpenAI client SDKs:
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="dummy")

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Click the submit button"}],
    tools=[{"type": "function", "function": {"name": "computer_use"}}],
)
```

### 6. Full-Duplex Agent WebSocket: `WS /v1/cua/session`
Streams out live video frames (`{ "type": "frame", "frameId": 12, "image": "data:image/jpeg;base64,..." }`) and receives live action payloads over a single persistent connection.

---

## Development

```bash
nix develop            # weston 15, pipewire, gcc, pkg-config, bun
make                   # builds both native modules and type-checks TypeScript
bun test tests/        # test suite; compositor-dependent suites skip without weston
scripts/e2e.sh         # full end-to-end proof against a real weston + PipeWire session
```

`scripts/e2e.sh` starts the real CLI and checks the whole path: the injector socket answers `PING`/`INFO`, live frames come from PipeWire capture (the synthetic fallback is rejected), typed input changes the rendered output, the MJPEG stream emits multipart frames, and the agent WebSocket streams frames and executes actions.

Environment variables (all optional):
- `WSTN_WESTON_BIN`: use a specific `weston` binary instead of the one on `PATH`.
- `WSTN_INJECTOR_MODULE`: use a `libwstn_injector.so` built outside the repository.
- `PW_STREAM_BIN`: use a `pw_stream` capture helper built outside the repository.

---

## Testing & Quality Verification

The project is strictly typed and verified against real runtimes:

```bash
make test
```

- The full suite passes against a real weston compositor: 75 tests across 4 files (`tests/cua-actions.test.ts`, `tests/pipewire-stream.test.ts`, `tests/server-and-supervisor.test.ts`, `tests/full-lifecycle.test.ts`).
- Suites that need a compositor are skipped automatically when `weston` is not on `PATH`, so the rest of the suite still runs (and passes) on machines without weston.
- Full TypeScript type-checking (`tsc`) passing with `exactOptionalPropertyTypes: true`, `noImplicitAny: true`, and `noUncheckedIndexedAccess: true`.
- The native C modules compile warning-free with `-Wall -Wextra`.

---

## License

Apache-2.0
