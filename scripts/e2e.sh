#!/usr/bin/env bash
# End-to-end verification against a real weston compositor:
#   - the native injector module loads and answers PING/INFO on its socket
#   - live frames arrive from the PipeWire capture (not the synthetic fallback)
#   - injected keyboard input changes what the compositor renders
#   - MJPEG and the agent WebSocket stay live
#
# Usage: scripts/e2e.sh [--port 17860]
# Requires: weston on PATH (or WSTN_WESTON_BIN), built native modules (make native),
#           bun, curl, a running PipeWire session.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=17860
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

cd "$ROOT"
OUT="$(mktemp -d -t wstn-cua-e2e.XXXXXX)"
FAILURES=0

check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    echo "  ok   $label${detail:+ ($detail)}"
  else
    echo "  FAIL $label${detail:+ ($detail)}"
    FAILURES=$((FAILURES + 1))
  fi
}

cleanup() {
  if [ -n "${APP_PID:-}" ]; then
    kill "$APP_PID" 2>/dev/null
    sleep 1
    kill -9 "$APP_PID" 2>/dev/null
  fi
  pkill -f "weston --backend=.*--socket=wayland-cua-" 2>/dev/null
  pkill -f "src/native/pw_stream" 2>/dev/null
}
trap cleanup EXIT

if ! command -v weston >/dev/null 2>&1 && [ -z "${WSTN_WESTON_BIN:-}" ]; then
  echo "weston not found; run inside the project dev shell (nix develop) or set WSTN_WESTON_BIN" >&2
  exit 2
fi

if [ ! -f src/native/libwstn_injector.so ] || [ ! -x src/native/pw_stream ]; then
  echo "native modules missing; building (make native)..."
  make native >/dev/null || exit 2
fi

echo "== starting wstn-cua on port $PORT"
bun run src/cli/index.ts start --port "$PORT" --width 1280 --height 800 > "$OUT/app.log" 2>&1 &
APP_PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/v1/cua/screen" > "$OUT/screen.json" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
check "gateway is up" "$ready"
if [ "$ready" != "1" ]; then
  echo "--- app log ---"
  tail -20 "$OUT/app.log"
  exit 1
fi

status=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).status)' "$OUT/screen.json")
check "weston reports running" "$([ "$status" = "running" ] && echo 1 || echo 0)" "status=$status"

sock=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).input_socket)' "$OUT/screen.json")
reply=$(bun -e '
const net = require("node:net");
const s = net.createConnection(process.argv[process.argv.length - 1]);
let out = "";
s.on("connect", () => s.write("PING\nINFO\n"));
s.on("data", (d) => { out += d.toString(); });
s.on("error", () => {});
setTimeout(() => { process.stdout.write(out.trim()); process.exit(0); }, 600);
' "$sock")
check "injector socket answers PING" "$(echo "$reply" | grep -q PONG && echo 1 || echo 0)"
check "injector reports display size" "$(echo "$reply" | grep -q 'width=1280 height=800' && echo 1 || echo 0)" "$(echo "$reply" | tr '\n' ' ')"

sleep 2
curl -s "http://127.0.0.1:$PORT/v1/cua/live-frame" -o "$OUT/frame1.jpg"
frame_bytes=$(stat -c%s "$OUT/frame1.jpg" 2>/dev/null || echo 0)
# Synthetic fallback frames embed a COM marker with "frameId"; real captures do not.
if grep -aq frameId "$OUT/frame1.jpg"; then
  check "live frame comes from PipeWire capture" 0 "got synthetic frame"
else
  check "live frame comes from PipeWire capture" 1 "size=${frame_bytes}B"
fi

actions=$(curl -s -X POST -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/v1/cua/actions" \
  -d '{"actions":[{"action":"move","coordinate":[300,400]},{"action":"click","coordinate":[300,400]},{"action":"type","text":"e2e"},{"action":"keypress","keys":"Return"},{"action":"scroll","delta_y":-100},{"action":"screenshot"}]}')
echo "$actions" > "$OUT/actions.json"
check "batch actions execute" "$(echo "$actions" | grep -q '"status": "success"' && echo 1 || echo 0)"
acted=$(bun -e 'const r = (await Bun.file(process.argv[1]).json()).results; console.log(r.filter((a) => a.status === "success").length + "/" + r.length)' "$OUT/actions.json")
check "all six actions succeeded" "$([ "$acted" = "6/6" ] && echo 1 || echo 0)" "$acted"

launch=$(curl -s -X POST -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/v1/apps/launch" -d '{"command":"weston-terminal"}')
check "weston-terminal launches in the sandbox" "$(echo "$launch" | grep -q '"status": "launched"' && echo 1 || echo 0)"
sleep 3

curl -s "http://127.0.0.1:$PORT/v1/cua/live-frame" -o "$OUT/frame-before.jpg"
curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/cua/actions" \
  -d '{"actions":[{"action":"type","text":"echo hello-from-e2e"},{"action":"keypress","keys":"Return"}]}' >/dev/null
sleep 2
curl -s "http://127.0.0.1:$PORT/v1/cua/live-frame" -o "$OUT/frame-after.jpg"
if cmp -s "$OUT/frame-before.jpg" "$OUT/frame-after.jpg"; then
  check "typed input changes rendered output" 0 "frames identical"
else
  check "typed input changes rendered output" 1
fi

timeout 3 curl -s "http://127.0.0.1:$PORT/v1/cua/stream" -o "$OUT/mjpeg.bin" || true
check "MJPEG stream emits frames" "$(grep -aq -- '--frame' "$OUT/mjpeg.bin" && echo 1 || echo 0)" "$(stat -c%s "$OUT/mjpeg.bin" 2>/dev/null || echo 0)B"

ws=$(bun -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:" + process.argv[process.argv.length - 1] + "/v1/cua/session");
let frames = 0, replies = 0;
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "frame") frames++;
  if (m.id === "e2e") replies++;
});
ws.on("error", () => process.exit(0));
setTimeout(() => {
  ws.send(JSON.stringify({ id: "e2e", action: { action: "move", coordinate: [10, 10] } }));
  setTimeout(() => { console.log(frames + " " + replies); process.exit(0); }, 700);
}, 1200);
' "$PORT")
check "agent WebSocket streams frames" "$(echo "$ws" | awk '{print ($1 > 0) ? 1 : 0}')" "frames=$(echo "$ws" | awk '{print $1}')"
check "agent WebSocket executes actions" "$(echo "$ws" | awk '{print ($2 > 0) ? 1 : 0}')"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "E2E PASSED (artifacts in $OUT)"
else
  echo "E2E FAILED: $FAILURES check(s) failed; artifacts in $OUT"
  tail -20 "$OUT/app.log"
  exit 1
fi
