import { describe, expect, it, beforeEach } from "bun:test";
import {
  CUAActionSchema,
  ClickActionSchema,
  DragActionSchema,
  TypeActionSchema,
  WaitActionSchema,
  OPENAI_CUA_TOOL_DEFINITION,
  CUA_ACTION_NAMES,
  CUAActionResultSchema,
  isCUAAction,
  parseCUAAction,
  safeParseCUAAction,
  type CUAAction,
} from "../src/cua/types.js";
import {
  resolveKeycode,
  requireKeycode,
  parseKeyCombo,
  decomposeText,
  textToKeyEvents,
  isModifierKey,
  isModifierKeycode,
  KEY_ENTER,
  KEY_BACKSPACE,
  KEY_TAB,
  KEY_SPACE,
  KEY_ESC,
  KEY_LEFTSHIFT,
  KEY_RIGHTSHIFT,
  KEY_LEFTCTRL,
  KEY_RIGHTCTRL,
  KEY_LEFTALT,
  KEY_RIGHTALT,
  KEY_LEFTMETA,
  KEY_UP,
  KEY_DOWN,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_PAGEUP,
  KEY_PAGEDOWN,
  KEY_HOME,
  KEY_END,
  KEY_DELETE,
  KEY_INSERT,
  KEY_F1,
  KEY_F12,
  KEY_A,
  KEY_T,
  KEY_C,
  KEY_1,
  KEY_2,
  KEY_0,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_MIDDLE,
} from "../src/cua/keymap.js";
import {
  ActionExecutor,
  MockInjectorTransport,
} from "../src/cua/action-executor.js";
import { CUAAgentSession } from "../src/cua/agent-session.js";

describe("CUA Action Schemas and Types", () => {
  it("validates all 16 canonical CUA actions via discriminated union", () => {
    const testCases: CUAAction[] = [
      { action: "click", coordinate: [100, 200] },
      { action: "click", coordinate: [100, 200], button: "right", modifiers: ["ctrl"] },
      { action: "double_click", coordinate: [150, 250] },
      { action: "triple_click", coordinate: [200, 300] },
      { action: "middle_click", coordinate: [50, 75] },
      { action: "right_click", coordinate: [80, 90] },
      { action: "mouse_down", button: "left", coordinate: [10, 20] },
      { action: "mouse_up", button: "left" },
      { action: "move", coordinate: [500, 400] },
      { action: "drag", start: [100, 100], end: [300, 300], path: [[200, 150]] },
      { action: "type", text: "Hello, wstn!" },
      { action: "keypress", keys: "ctrl+shift+t" },
      { action: "keypress", keys: ["ctrl", "c"] },
      { action: "key_down", key: "Shift_L" },
      { action: "key_up", key: "Shift_L" },
      { action: "scroll", delta_y: -120, coordinate: [600, 400] },
      { action: "wait", duration_ms: 500 },
      { action: "screenshot" },
    ];

    for (const testCase of testCases) {
      const parsed = CUAActionSchema.parse(testCase);
      expect(parsed.action).toBe(testCase.action);
      expect(isCUAAction(testCase)).toBe(true);
    }
  });

  it("rejects invalid actions constructively", () => {
    // Missing action discriminant
    expect(safeParseCUAAction({ coordinate: [10, 20] }).success).toBe(false);

    // Invalid action literal name
    expect(safeParseCUAAction({ action: "fly", coordinate: [10, 20] }).success).toBe(false);

    // Invalid coordinate shape
    expect(safeParseCUAAction({ action: "click", coordinate: [10] }).success).toBe(false);
    expect(safeParseCUAAction({ action: "click", coordinate: ["x", "y"] }).success).toBe(false);

    // Invalid button
    expect(safeParseCUAAction({ action: "click", coordinate: [10, 20], button: "fourth" }).success).toBe(false);

    // Negative wait duration
    expect(safeParseCUAAction({ action: "wait", duration_ms: -100 }).success).toBe(false);

    // Missing text in type
    expect(safeParseCUAAction({ action: "type" }).success).toBe(false);

    // Missing start or end in drag
    expect(safeParseCUAAction({ action: "drag", start: [10, 20] }).success).toBe(false);
  });

  it("verifies OPENAI_CUA_TOOL_DEFINITION conforms to specification", () => {
    expect(OPENAI_CUA_TOOL_DEFINITION.type).toBe("computer_use");
    expect(OPENAI_CUA_TOOL_DEFINITION.name).toBe("computer_use");
    expect(OPENAI_CUA_TOOL_DEFINITION.parameters.required).toContain("action");

    const enumActions = OPENAI_CUA_TOOL_DEFINITION.parameters.properties.action.enum;
    expect(enumActions.length).toBe(16);
    for (const actionName of CUA_ACTION_NAMES) {
      expect(enumActions).toContain(actionName);
    }

    const meta = OPENAI_CUA_TOOL_DEFINITION.meta;
    expect(meta.coordinate_system.origin).toBe("top-left");
    expect(meta.coordinate_system.default_resolution.width).toBe(1280);
    expect(meta.coordinate_system.default_resolution.height).toBe(800);
    expect(meta.endpoints.portal_url).toBe("/portal");
    expect(meta.endpoints.stream_url).toBe("/portal/stream");
  });

  it("validates CUAActionResult schema", () => {
    const successResult = {
      status: "success" as const,
      action: "click",
      duration_ms: 42,
      live_feed: {
        portal_url: "/portal",
        stream_url: "/portal/stream",
        frame_id: 105,
      },
    };
    expect(CUAActionResultSchema.safeParse(successResult).success).toBe(true);

    const errorResult = {
      status: "error" as const,
      action: "drag",
      duration_ms: 12,
      error: "Socket write failed",
    };
    expect(CUAActionResultSchema.safeParse(errorResult).success).toBe(true);
  });
});

describe("Keymap and Keycode Resolution", () => {
  it("maps special keys to Linux evdev keycodes accurately", () => {
    expect(resolveKeycode("Return")).toBe(KEY_ENTER);
    expect(resolveKeycode("Enter")).toBe(KEY_ENTER);
    expect(resolveKeycode("enter")).toBe(KEY_ENTER);
    expect(resolveKeycode("BackSpace")).toBe(KEY_BACKSPACE);
    expect(resolveKeycode("backspace")).toBe(KEY_BACKSPACE);
    expect(resolveKeycode("Tab")).toBe(KEY_TAB);
    expect(resolveKeycode("tab")).toBe(KEY_TAB);
    expect(resolveKeycode("Space")).toBe(KEY_SPACE);
    expect(resolveKeycode(" ")).toBe(KEY_SPACE);
    expect(resolveKeycode("Escape")).toBe(KEY_ESC);
    expect(resolveKeycode("esc")).toBe(KEY_ESC);

    // Modifiers
    expect(resolveKeycode("Shift_L")).toBe(KEY_LEFTSHIFT);
    expect(resolveKeycode("Shift")).toBe(KEY_LEFTSHIFT);
    expect(resolveKeycode("Shift_R")).toBe(KEY_RIGHTSHIFT);
    expect(resolveKeycode("Control_L")).toBe(KEY_LEFTCTRL);
    expect(resolveKeycode("Control")).toBe(KEY_LEFTCTRL);
    expect(resolveKeycode("Ctrl")).toBe(KEY_LEFTCTRL);
    expect(resolveKeycode("Control_R")).toBe(KEY_RIGHTCTRL);
    expect(resolveKeycode("Alt_L")).toBe(KEY_LEFTALT);
    expect(resolveKeycode("Alt")).toBe(KEY_LEFTALT);
    expect(resolveKeycode("Alt_R")).toBe(KEY_RIGHTALT);
    expect(resolveKeycode("Super_L")).toBe(KEY_LEFTMETA);
    expect(resolveKeycode("Super")).toBe(KEY_LEFTMETA);
    expect(resolveKeycode("Meta")).toBe(KEY_LEFTMETA);

    // Arrows
    expect(resolveKeycode("ArrowUp")).toBe(KEY_UP);
    expect(resolveKeycode("Up")).toBe(KEY_UP);
    expect(resolveKeycode("ArrowDown")).toBe(KEY_DOWN);
    expect(resolveKeycode("Down")).toBe(KEY_DOWN);
    expect(resolveKeycode("ArrowLeft")).toBe(KEY_LEFT);
    expect(resolveKeycode("Left")).toBe(KEY_LEFT);
    expect(resolveKeycode("ArrowRight")).toBe(KEY_RIGHT);
    expect(resolveKeycode("Right")).toBe(KEY_RIGHT);

    // Navigation
    expect(resolveKeycode("Page_Up")).toBe(KEY_PAGEUP);
    expect(resolveKeycode("PageUp")).toBe(KEY_PAGEUP);
    expect(resolveKeycode("Page_Down")).toBe(KEY_PAGEDOWN);
    expect(resolveKeycode("PageDown")).toBe(KEY_PAGEDOWN);
    expect(resolveKeycode("Home")).toBe(KEY_HOME);
    expect(resolveKeycode("End")).toBe(KEY_END);
    expect(resolveKeycode("Delete")).toBe(KEY_DELETE);
    expect(resolveKeycode("Insert")).toBe(KEY_INSERT);

    // Function keys F1-F12
    expect(resolveKeycode("F1")).toBe(KEY_F1);
    expect(resolveKeycode("f1")).toBe(KEY_F1);
    expect(resolveKeycode("F12")).toBe(KEY_F12);
    expect(resolveKeycode("f12")).toBe(KEY_F12);
  });

  it("maps alphanumeric keys 'a'-'z' and '0'-'9'", () => {
    expect(resolveKeycode("a")).toBe(KEY_A);
    expect(resolveKeycode("A")).toBe(KEY_A);
    expect(resolveKeycode("t")).toBe(KEY_T);
    expect(resolveKeycode("c")).toBe(KEY_C);

    expect(resolveKeycode("0")).toBe(KEY_0);
    expect(resolveKeycode("1")).toBe(KEY_1);
    expect(resolveKeycode("9")).toBe(10);
  });

  it("identifies modifier keycodes correctly", () => {
    expect(isModifierKeycode(KEY_LEFTCTRL)).toBe(true);
    expect(isModifierKeycode(KEY_RIGHTSHIFT)).toBe(true);
    expect(isModifierKeycode(KEY_LEFTALT)).toBe(true);
    expect(isModifierKeycode(KEY_LEFTMETA)).toBe(true);
    expect(isModifierKeycode(KEY_A)).toBe(false);

    expect(isModifierKey("ctrl")).toBe(true);
    expect(isModifierKey("Shift")).toBe(true);
    expect(isModifierKey("a")).toBe(false);
  });

  it("throws for unknown key names", () => {
    expect(() => requireKeycode("NonExistentKey123")).toThrow("Unknown key name");
  });
});

describe("Modifier Combo Parser", () => {
  it("parses single key without modifiers", () => {
    const combo = parseKeyCombo("Return");
    expect(combo.modifiersDown).toEqual([]);
    expect(combo.targetKey).toBe(KEY_ENTER);
    expect(combo.modifiersUp).toEqual([]);
  });

  it("parses two-key combo: 'ctrl+c'", () => {
    const combo = parseKeyCombo("ctrl+c");
    expect(combo.modifiersDown).toEqual([KEY_LEFTCTRL]);
    expect(combo.targetKey).toBe(KEY_C);
    expect(combo.modifiersUp).toEqual([KEY_LEFTCTRL]);
  });

  it("parses three-key combo: 'ctrl+shift+t' in correct order and reverse release", () => {
    const combo = parseKeyCombo("ctrl+shift+t");
    expect(combo.modifiersDown).toEqual([KEY_LEFTCTRL, KEY_LEFTSHIFT]);
    expect(combo.targetKey).toBe(KEY_T);
    expect(combo.modifiersUp).toEqual([KEY_LEFTSHIFT, KEY_LEFTCTRL]);
  });

  it("parses 'alt+f4'", () => {
    const combo = parseKeyCombo("alt+f4");
    expect(combo.modifiersDown).toEqual([KEY_LEFTALT]);
    expect(combo.targetKey).toBe(62); // KEY_F4
    expect(combo.modifiersUp).toEqual([KEY_LEFTALT]);
  });

  it("parses array of keys: ['ctrl', 'alt', 'delete']", () => {
    const combo = parseKeyCombo(["ctrl", "alt", "delete"]);
    expect(combo.modifiersDown).toEqual([KEY_LEFTCTRL, KEY_LEFTALT]);
    expect(combo.targetKey).toBe(KEY_DELETE);
    expect(combo.modifiersUp).toEqual([KEY_LEFTALT, KEY_LEFTCTRL]);
  });

  it("handles solo modifier press gracefully", () => {
    const combo = parseKeyCombo("ctrl");
    expect(combo.modifiersDown).toEqual([]);
    expect(combo.targetKey).toBe(KEY_LEFTCTRL);
    expect(combo.modifiersUp).toEqual([]);
  });
});

describe("String Typer", () => {
  it("decomposes lowercase text without Shift", () => {
    const strokes = decomposeText("cat");
    expect(strokes.length).toBe(3);
    expect(strokes[0]?.shift).toBe(false);
    expect(strokes[1]?.shift).toBe(false);
    expect(strokes[2]?.shift).toBe(false);
  });

  it("decomposes uppercase text with Shift flag", () => {
    const strokes = decomposeText("AI");
    expect(strokes.length).toBe(2);
    expect(strokes[0]?.shift).toBe(true);
    expect(strokes[1]?.shift).toBe(true);
  });

  it("decomposes shifted symbols correctly", () => {
    const shiftedSymbols = "!@#$%^&*()_+{}:\"<>?~|";
    const strokes = decomposeText(shiftedSymbols);
    expect(strokes.length).toBe(shiftedSymbols.length);
    for (const stroke of strokes) {
      expect(stroke.shift).toBe(true);
    }

    // Specific keycode checks
    const excl = strokes[0];
    expect(excl?.char).toBe("!");
    expect(excl?.keycode).toBe(KEY_1);
    expect(excl?.shift).toBe(true);

    const at = strokes[1];
    expect(at?.char).toBe("@");
    expect(at?.keycode).toBe(KEY_2);
    expect(at?.shift).toBe(true);
  });

  it("generates balanced evdev key events for typed string", () => {
    const events = textToKeyEvents("Hi!");
    // 'H' (shifted): Shift down, H down, H up, Shift up (4 events)
    // 'i' (unshifted): i down, i up (2 events)
    // '!' (shifted): Shift down, 1 down, 1 up, Shift up (4 events)
    // Total = 10 events
    expect(events.length).toBe(10);

    expect(events[0]?.code).toBe(KEY_LEFTSHIFT);
    expect(events[0]?.state).toBe(1);
    expect(events[3]?.code).toBe(KEY_LEFTSHIFT);
    expect(events[3]?.state).toBe(0);

    expect(events[4]?.state).toBe(1);
    expect(events[5]?.state).toBe(0);

    expect(events[6]?.code).toBe(KEY_LEFTSHIFT);
    expect(events[6]?.state).toBe(1);
    expect(events[9]?.code).toBe(KEY_LEFTSHIFT);
    expect(events[9]?.state).toBe(0);
  });
});

describe("ActionExecutor", () => {
  let transport: MockInjectorTransport;
  let executor: ActionExecutor;

  beforeEach(() => {
    transport = new MockInjectorTransport();
    executor = new ActionExecutor({
      transport,
      screenWidth: 1280,
      screenHeight: 800,
      clickDelayMs: 0,
      doubleClickDelayMs: 0,
      typeDelayMs: 0,
      dragStepDelayMs: 0,
    });
  });

  it("clamps out-of-boundary coordinates to screen limits", async () => {
    await executor.execute({ action: "move", coordinate: [-50, 950] });

    expect(transport.events.length).toBe(1);
    const event = transport.events[0];
    expect(event?.type).toBe("motion");
    if (event && event.type === "motion") {
      expect(event.x).toBe(0);
      expect(event.y).toBe(799);
    }
  });

  it("executes click action with left button", async () => {
    const result = await executor.execute({ action: "click", coordinate: [100, 200] });

    expect(result.status).toBe("success");
    expect(result.action).toBe("click");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    expect(transport.events.length).toBe(3);
    expect(transport.events[0]).toEqual({ type: "motion", x: 100, y: 200 });
    expect(transport.events[1]).toEqual({ type: "button", button: BTN_LEFT, state: 1 });
    expect(transport.events[2]).toEqual({ type: "button", button: BTN_LEFT, state: 0 });
  });

  it("executes right click and middle click actions", async () => {
    await executor.execute({ action: "right_click", coordinate: [300, 400] });
    expect(transport.events.some((e) => e.type === "button" && e.button === BTN_RIGHT)).toBe(true);

    transport.clear();
    await executor.execute({ action: "middle_click", coordinate: [300, 400] });
    expect(transport.events.some((e) => e.type === "button" && e.button === BTN_MIDDLE)).toBe(true);
  });

  it("executes click with modifiers, releasing modifiers afterwards", async () => {
    await executor.execute({
      action: "click",
      coordinate: [50, 50],
      modifiers: ["ctrl", "shift"],
    });

    // Modifiers down, motion, button down, button up, modifiers up
    const keyEvents = transport.events.filter((e) => e.type === "key");
    expect(keyEvents.length).toBe(4);

    expect(keyEvents[0]).toEqual({ type: "key", code: KEY_LEFTCTRL, state: 1 });
    expect(keyEvents[1]).toEqual({ type: "key", code: KEY_LEFTSHIFT, state: 1 });
    expect(keyEvents[2]).toEqual({ type: "key", code: KEY_LEFTSHIFT, state: 0 });
    expect(keyEvents[3]).toEqual({ type: "key", code: KEY_LEFTCTRL, state: 0 });
  });

  it("executes double_click and triple_click", async () => {
    await executor.execute({ action: "double_click", coordinate: [120, 130] });
    const buttonEvents = transport.events.filter((e) => e.type === "button");
    expect(buttonEvents.length).toBe(4); // 2 down, 2 up

    transport.clear();
    await executor.execute({ action: "triple_click", coordinate: [120, 130] });
    const tripleButtonEvents = transport.events.filter((e) => e.type === "button");
    expect(tripleButtonEvents.length).toBe(6); // 3 down, 3 up
  });

  it("executes drag with smooth interpolation", async () => {
    await executor.execute({ action: "drag", start: [100, 100], end: [200, 200] });

    const motions = transport.events.filter((e) => e.type === "motion");
    expect(motions.length).toBeGreaterThan(5);

    const firstMotion = motions[0];
    const lastMotion = motions[motions.length - 1];
    expect(firstMotion).toEqual({ type: "motion", x: 100, y: 100 });
    expect(lastMotion).toEqual({ type: "motion", x: 200, y: 200 });

    const buttons = transport.events.filter((e) => e.type === "button");
    expect(buttons[0]).toEqual({ type: "button", button: BTN_LEFT, state: 1 });
    expect(buttons[buttons.length - 1]).toEqual({ type: "button", button: BTN_LEFT, state: 0 });
  });

  it("executes scroll with vertical and horizontal axes", async () => {
    await executor.execute({
      action: "scroll",
      delta_y: 100,
      delta_x: -50,
      coordinate: [400, 300],
    });

    const axes = transport.events.filter((e) => e.type === "axis");
    expect(axes.length).toBe(2);
    expect(axes[0]).toEqual({ type: "axis", axis: "vertical", value: 100 });
    expect(axes[1]).toEqual({ type: "axis", axis: "horizontal", value: -50 });
  });

  it("executes wait and records duration accurately", async () => {
    const result = await executor.execute({ action: "wait", duration_ms: 15 });
    expect(result.status).toBe("success");
    expect(result.duration_ms).toBeGreaterThanOrEqual(10);
  });

  it("handles execution errors gracefully without throwing", async () => {
    // Malformed key down
    const result = await executor.execute({ action: "key_down", key: "BadKey_xyz" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("Unknown key name");
  });
});

describe("CUAAgentSession", () => {
  let transport: MockInjectorTransport;
  let session: CUAAgentSession;

  beforeEach(() => {
    transport = new MockInjectorTransport();
    session = new CUAAgentSession({
      width: 1280,
      height: 800,
      executorOptions: {
        transport,
        clickDelayMs: 0,
        doubleClickDelayMs: 0,
        typeDelayMs: 0,
        dragStepDelayMs: 0,
      },
    });
  });

  it("tracks mouse position across actions", async () => {
    expect(session.getMousePosition()).toEqual([0, 0]);

    await session.executeAction({ action: "move", coordinate: [350, 450] });
    expect(session.getMousePosition()).toEqual([350, 450]);

    await session.executeAction({ action: "click", coordinate: [500, 600] });
    expect(session.getMousePosition()).toEqual([500, 600]);
  });

  it("tracks active modifiers through key_down and key_up", async () => {
    expect(session.getActiveModifiers()).toEqual([]);

    await session.executeAction({ action: "key_down", key: "Control_L" });
    expect(session.getActiveModifiers().length).toBe(1);

    await session.executeAction({ action: "key_up", key: "Control_L" });
    expect(session.getActiveModifiers().length).toBe(0);
  });

  it("records chronological action history", async () => {
    await session.executeAction({ action: "move", coordinate: [100, 100] });
    await session.executeAction({ action: "type", text: "ok" });

    const history = session.getHistory();
    expect(history.length).toBe(2);
    expect(history[0]?.action.action).toBe("move");
    expect(history[1]?.action.action).toBe("type");
    expect(history[0]?.result.status).toBe("success");
  });

  it("serializes concurrent action calls sequentially", async () => {
    const executionOrder: string[] = [];

    const act1 = session.executeAction({ action: "move", coordinate: [10, 10] }).then(() => {
      executionOrder.push("act1");
    });
    const act2 = session.executeAction({ action: "move", coordinate: [20, 20] }).then(() => {
      executionOrder.push("act2");
    });
    const act3 = session.executeAction({ action: "move", coordinate: [30, 30] }).then(() => {
      executionOrder.push("act3");
    });

    await Promise.all([act1, act2, act3]);
    expect(executionOrder).toEqual(["act1", "act2", "act3"]);
  });

  it("resets session state, releases modifiers, and centers cursor", async () => {
    await session.executeAction({ action: "key_down", key: "Shift_L" });
    await session.executeAction({ action: "move", coordinate: [10, 10] });

    await session.reset();

    expect(session.getActiveModifiers()).toEqual([]);
    expect(session.getMousePosition()).toEqual([640, 400]); // Centered in 1280x800
  });
});
