// wstn-cua Web Control Center Frontend Application

let ws = null;
let isInteractive = false;
let targetWidth = 1280;
let targetHeight = 800;
let frameCount = 0;
let fps = 0;
const ripples = [];

// DOM Element References
const statusDot = document.getElementById("status-dot");
const compositorStatus = document.getElementById("compositor-status");
const fpsCounter = document.getElementById("fps-counter");
const latencyCounter = document.getElementById("latency-counter");
const displayPill = document.getElementById("display-pill");
const pipewirePill = document.getElementById("pipewire-pill");
const resIndicator = document.getElementById("res-indicator");
const frameStatusText = document.getElementById("frame-status-text");

const interactiveBtn = document.getElementById("interactive-btn");
const snapshotBtn = document.getElementById("snapshot-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");

const appLayout = document.getElementById("app-layout");
const screenFrame = document.getElementById("screen-frame");
const viewportBox = document.getElementById("viewport-box");
const streamImage = document.getElementById("stream-image");
const actionCanvas = document.getElementById("action-canvas");
const coordTag = document.getElementById("coord-tag");

const quickTypeForm = document.getElementById("quick-type-form");
const quickTypeInput = document.getElementById("quick-type-input");

const launchBrowserBtn = document.getElementById("launch-browser-btn");
const launchTerminalBtn = document.getElementById("launch-terminal-btn");
const launchEglBtn = document.getElementById("launch-egl-btn");
const customCmdForm = document.getElementById("custom-cmd-form");
const customCmdInput = document.getElementById("custom-cmd-input");

const feedList = document.getElementById("feed-list");
const clearFeedBtn = document.getElementById("clear-feed-btn");

const testerForm = document.getElementById("tester-form");
const actionTypeSelect = document.getElementById("action-type-select");
const coordInputs = document.getElementById("coord-inputs");
const coordXVal = document.getElementById("coord-x-val");
const coordYVal = document.getElementById("coord-y-val");
const textInputRow = document.getElementById("text-input-row");
const textVal = document.getElementById("text-val");
const keysInputRow = document.getElementById("keys-input-row");
const keysVal = document.getElementById("keys-val");
const scrollInputRow = document.getElementById("scroll-input-row");
const scrollYVal = document.getElementById("scroll-y-val");
const resultTerminal = document.getElementById("result-terminal");
const specCodeBox = document.getElementById("spec-code-box");
const toastContainer = document.getElementById("toast-container");

// Canvas Setup
const ctx = actionCanvas.getContext("2d");

function resizeCanvas() {
  if (streamImage && actionCanvas) {
    const rect = streamImage.getBoundingClientRect();
    actionCanvas.width = rect.width || 1280;
    actionCanvas.height = rect.height || 800;
  }
}
window.addEventListener("resize", resizeCanvas);
streamImage.addEventListener("load", () => {
  resizeCanvas();
  frameCount++;
});

// Toast notifications
function showToast(message) {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Add visual ripple on canvas
function addRipple(x, y, color = "#38bdf8", label = "") {
  ripples.push({
    x,
    y,
    radius: 4,
    maxRadius: 32,
    alpha: 1.0,
    color,
    label,
  });
}

function animateCanvas() {
  ctx.clearRect(0, 0, actionCanvas.width, actionCanvas.height);

  const scaleX = actionCanvas.width / targetWidth;
  const scaleY = actionCanvas.height / targetHeight;

  for (let i = ripples.length - 1; i >= 0; i--) {
    const rip = ripples[i];
    rip.radius += 1.6;
    rip.alpha -= 0.04;

    if (rip.alpha <= 0) {
      ripples.splice(i, 1);
      continue;
    }

    const cx = rip.x * scaleX;
    const cy = rip.y * scaleY;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rip.radius, 0, 2 * Math.PI);
    ctx.strokeStyle = rip.color;
    ctx.globalAlpha = rip.alpha;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Inner center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = rip.color;
    ctx.fill();

    if (rip.label && rip.alpha > 0.3) {
      ctx.font = "11px monospace";
      ctx.fillStyle = rip.color;
      ctx.fillText(`${rip.label} (${rip.x}, ${rip.y})`, cx + rip.radius + 6, cy + 4);
    }
    ctx.restore();
  }

  requestAnimationFrame(animateCanvas);
}
requestAnimationFrame(animateCanvas);

// WebSocket Connection to Portal
function connectPortalWs() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/v1/cua/portal`;

  ws = new WebSocket(wsUrl);

  let pingStart = 0;
  let pingInterval = null;

  ws.onopen = () => {
    statusDot.classList.remove("error");
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        pingStart = performance.now();
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 2000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "pong") {
        const latency = Math.round(performance.now() - pingStart);
        latencyCounter.textContent = `${latency} ms`;
        return;
      }

      if (msg.type === "init" || msg.type === "stats") {
        updateSupervisorStatus(msg.status);
        if (Array.isArray(msg.recentActions)) {
          updateAgentConsole(msg.recentActions);
        }
      }

      if (msg.type === "agent_action") {
        handleRealtimeAgentAction(msg.action, msg.result);
      }
    } catch {
      // Ignore parse error
    }
  };

  ws.onclose = () => {
    statusDot.classList.add("error");
    if (pingInterval) clearInterval(pingInterval);
    setTimeout(connectPortalWs, 2000);
  };
}

function updateSupervisorStatus(status) {
  if (!status) return;
  targetWidth = status.width || 1280;
  targetHeight = status.height || 800;
  resIndicator.textContent = `${targetWidth} × ${targetHeight}`;

  if (displayPill) displayPill.textContent = status.waylandDisplay || "none";
  if (pipewirePill) pipewirePill.textContent = status.pipewireNode || "none";

  if (status.status === "running") {
    statusDot.classList.remove("error");
    compositorStatus.textContent = "WESTON ACTIVE";
  } else {
    statusDot.classList.add("error");
    compositorStatus.textContent = String(status.status).toUpperCase();
  }
}

function handleRealtimeAgentAction(action, result) {
  if (!action) return;

  const card = document.createElement("div");
  const isErr = result?.status === "error";
  card.className = `feed-card ${isErr ? "error" : "success"}`;
  const dur = result?.duration_ms ? `${result.duration_ms}ms` : "now";

  let detail = JSON.stringify(action);
  if (action.action === "type") detail = `Type: "${action.text}"`;
  else if (action.action === "keypress") detail = `Key: ${action.keys}`;
  else if (action.coordinate) detail = `${action.action} @ (${action.coordinate[0]}, ${action.coordinate[1]})`;

  card.innerHTML = `
    <div class="feed-card-meta">
      <span class="feed-action-name">AGENT: ${String(action.action).toUpperCase()}</span>
      <span>${dur}</span>
    </div>
    <div class="feed-payload">${detail}</div>
  `;

  if (feedList) {
    feedList.prepend(card);
    if (feedList.children.length > 50) {
      feedList.removeChild(feedList.lastChild);
    }
  }

  // Canvas visual feedback
  if (action.coordinate) {
    const [x, y] = action.coordinate;
    const color = isErr ? "#f43f5e" : "#10b981";
    addRipple(x, y, color, `agent: ${action.action}`);
  }
}

function updateAgentConsole(actions) {
  if (!feedList || actions.length === 0) return;
  feedList.innerHTML = "";

  for (const act of actions) {
    const card = document.createElement("div");
    card.className = `feed-card ${act.status === "error" ? "error" : "success"}`;
    card.innerHTML = `
      <div class="feed-card-meta">
        <span class="feed-action-name">${String(act.action).toUpperCase()}</span>
        <span>${act.duration_ms}ms</span>
      </div>
      <div class="feed-payload">${act.error ? "Error: " + act.error : "Executed in " + act.duration_ms + "ms"}</div>
    `;
    feedList.appendChild(card);
  }
}

// FPS counter loop
setInterval(() => {
  fps = frameCount;
  frameCount = 0;
  fpsCounter.textContent = String(fps);
}, 1000);

// Interactive Mode Toggle
function setInteractive(active) {
  isInteractive = active;
  if (isInteractive) {
    interactiveBtn.classList.add("active");
    viewportBox.classList.add("interactive");
    screenFrame.classList.add("interactive-active");
    frameStatusText.textContent = "INTERACTIVE ACTIVE";
    showToast("Interactive mode enabled (Alt+I or Esc to exit)");
  } else {
    interactiveBtn.classList.remove("active");
    viewportBox.classList.remove("interactive");
    screenFrame.classList.remove("interactive-active");
    frameStatusText.textContent = "LIVE FEED";
  }
}

interactiveBtn.addEventListener("click", () => {
  setInteractive(!isInteractive);
});

// Coordinate Mapping
function getDesktopCoordinates(evt) {
  const rect = streamImage.getBoundingClientRect();
  const relX = (evt.clientX - rect.left) / rect.width;
  const relY = (evt.clientY - rect.top) / rect.height;

  const x = Math.min(Math.max(0, Math.round(relX * targetWidth)), targetWidth - 1);
  const y = Math.min(Math.max(0, Math.round(relY * targetHeight)), targetHeight - 1);
  return { x, y };
}

viewportBox.addEventListener("mousemove", (evt) => {
  const { x, y } = getDesktopCoordinates(evt);
  coordTag.textContent = `X: ${x}, Y: ${y}`;

  if (!isInteractive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "mouse_move", x, y }));
});

viewportBox.addEventListener("mousedown", (evt) => {
  const { x, y } = getDesktopCoordinates(evt);
  if (!isInteractive) {
    // If not interactive yet, clicking the viewport engages interactive mode
    setInteractive(true);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const button = evt.button === 2 ? "right" : evt.button === 1 ? "middle" : "left";
  ws.send(JSON.stringify({ type: "mouse_down", button, x, y }));

  const color = button === "right" ? "#f43f5e" : button === "middle" ? "#f59e0b" : "#38bdf8";
  addRipple(x, y, color, button);
});

viewportBox.addEventListener("mouseup", (evt) => {
  if (!isInteractive || !ws || ws.readyState !== WebSocket.OPEN) return;
  const { x, y } = getDesktopCoordinates(evt);
  const button = evt.button === 2 ? "right" : evt.button === 1 ? "middle" : "left";
  ws.send(JSON.stringify({ type: "mouse_up", button, x, y }));
});

viewportBox.addEventListener("contextmenu", (evt) => {
  if (isInteractive) {
    evt.preventDefault();
  }
});

viewportBox.addEventListener("wheel", (evt) => {
  if (!isInteractive || !ws || ws.readyState !== WebSocket.OPEN) return;
  evt.preventDefault();
  const deltaX = Math.round(evt.deltaX);
  const deltaY = Math.round(evt.deltaY);
  ws.send(JSON.stringify({ type: "scroll", deltaX, deltaY }));
}, { passive: false });

// Global Keyboard Handler
window.addEventListener("keydown", (evt) => {
  // Shortcut Alt+I toggles interactive mode anywhere
  if (evt.altKey && evt.key.toLowerCase() === "i") {
    evt.preventDefault();
    setInteractive(!isInteractive);
    return;
  }

  if (!isInteractive) return;

  // Esc disengages interactive mode
  if (evt.key === "Escape") {
    setInteractive(false);
    return;
  }

  // If typing in an input or form field, let the field handle it
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

  evt.preventDefault();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "key_down", key: evt.key }));
  }
});

window.addEventListener("keyup", (evt) => {
  if (!isInteractive) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

  evt.preventDefault();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "key_up", key: evt.key }));
  }
});

// Quick Keys Ribbon Helpers
window.sendKey = function (key) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "keypress", keys: key }));
    showToast(`Dispatched key: ${key}`);
  }
};

window.sendCombo = function (combo) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "keypress", keys: combo }));
    showToast(`Dispatched combo: ${combo}`);
  }
};

// Bind all Quick Key buttons in the ribbon
document.querySelectorAll(".key-cap").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-key");
    const combo = btn.getAttribute("data-combo");
    if (key) window.sendKey(key);
    else if (combo) window.sendCombo(combo);
  });
});

// Fast Quick-Type Form
quickTypeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = quickTypeInput.value;
  if (!text) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "type", text }));
    // Automatically press return after typing
    ws.send(JSON.stringify({ type: "keypress", keys: "Return" }));
    showToast(`Typed text into Weston: "${text}"`);
    quickTypeInput.value = "";
  }
});

// App Launching
window.launchApp = function (command) {
  fetch("/v1/apps/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  })
    .then((r) => r.json())
    .then((data) => {
      const cmdStr = Array.isArray(command) ? command.join(" ") : command;
      showToast(`Launched: ${cmdStr}`);
      const card = document.createElement("div");
      card.className = "feed-card success";
      card.innerHTML = `
        <div class="feed-card-meta"><span>LAUNCH APP</span><span>PID: ${data.pid || "ok"}</span></div>
        <div class="feed-payload">Started command: ${cmdStr}</div>
      `;
      feedList.prepend(card);
    })
    .catch((err) => {
      showToast(`Launch failed: ${err.message}`);
    });
};

launchBrowserBtn.addEventListener("click", () => window.launchApp("browser"));
launchTerminalBtn.addEventListener("click", () => window.launchApp("weston-terminal"));
launchEglBtn.addEventListener("click", () => window.launchApp("weston-simple-egl"));

customCmdForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const cmd = customCmdInput.value.trim();
  if (cmd) {
    window.launchApp(cmd);
    customCmdInput.value = "";
  }
});

// Snapshot Download
snapshotBtn.addEventListener("click", () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = "/v1/cua/live-frame?t=" + Date.now();
  a.download = `wstn-snapshot-${timestamp}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("Snapshot downloaded");
});

// Fullscreen Stage Toggle
fullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    screenFrame.requestFullscreen().catch(() => {
      showToast("Fullscreen request denied");
    });
  } else {
    document.exitFullscreen();
  }
});

// Sidebar Inspector Toggle
sidebarToggleBtn.addEventListener("click", () => {
  appLayout.classList.toggle("sidebar-collapsed");
  setTimeout(resizeCanvas, 220);
});

// Sidebar Tabs Switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    const targetId = btn.getAttribute("data-tab");
    const targetPane = document.getElementById(targetId);
    if (targetPane) targetPane.classList.add("active");
  });
});

// Clear Feed
clearFeedBtn.addEventListener("click", () => {
  feedList.innerHTML = `
    <div class="feed-card">
      <div class="feed-card-meta"><span>FEED</span><span>CLEARED</span></div>
      <div class="feed-payload">Log feed cleared. Waiting for next event.</div>
    </div>
  `;
});

// Action Tester Form Handling
actionTypeSelect.addEventListener("change", () => {
  const val = actionTypeSelect.value;
  coordInputs.style.display = ["click", "double_click", "right_click", "middle_click", "move"].includes(val) ? "grid" : "none";
  textInputRow.style.display = val === "type" ? "flex" : "none";
  keysInputRow.style.display = val === "keypress" ? "flex" : "none";
  scrollInputRow.style.display = val === "scroll" ? "flex" : "none";
});

testerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const actionType = actionTypeSelect.value;
  const x = parseInt(coordXVal.value, 10) || 0;
  const y = parseInt(coordYVal.value, 10) || 0;

  let payload = { action: actionType };

  if (["click", "double_click", "right_click", "middle_click", "move"].includes(actionType)) {
    payload.coordinate = [x, y];
    if (actionType === "right_click") {
      payload.button = "right";
      payload.action = "click";
    } else if (actionType === "middle_click") {
      payload.button = "middle";
      payload.action = "click";
    }
  } else if (actionType === "type") {
    payload.text = textVal.value || "wstn-cua";
  } else if (actionType === "keypress") {
    payload.keys = keysVal.value || "Return";
  } else if (actionType === "scroll") {
    payload.delta_y = parseInt(scrollYVal.value, 10) || 5;
  }

  resultTerminal.textContent = "Executing CUA action...";

  try {
    const t0 = performance.now();
    const res = await fetch("/v1/cua/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: payload }),
    });
    const data = await res.json();
    const roundTrip = Math.round(performance.now() - t0);
    resultTerminal.textContent = `[${roundTrip}ms total]\n` + JSON.stringify(data, null, 2);

    if (payload.coordinate) {
      addRipple(payload.coordinate[0], payload.coordinate[1], "#10b981", actionType);
    }
  } catch (err) {
    resultTerminal.textContent = "Error: " + err.message;
  }
});

// Load Tool Spec into API tab
async function loadToolSpec() {
  try {
    const res = await fetch("/v1/cua/spec");
    const data = await res.json();
    specCodeBox.textContent = JSON.stringify(data, null, 2);
  } catch {
    specCodeBox.textContent = "Failed to load OpenAI CUA tool specification.";
  }
}

// Initial Boot
connectPortalWs();
loadToolSpec();
