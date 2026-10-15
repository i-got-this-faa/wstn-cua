/**
 * Linux evdev keycodes from <linux/input-event-codes.h>.
 */
export const KEY_RESERVED = 0;
export const KEY_ESC = 1;
export const KEY_1 = 2;
export const KEY_2 = 3;
export const KEY_3 = 4;
export const KEY_4 = 5;
export const KEY_5 = 6;
export const KEY_6 = 7;
export const KEY_7 = 8;
export const KEY_8 = 9;
export const KEY_9 = 10;
export const KEY_0 = 11;
export const KEY_MINUS = 12;
export const KEY_EQUAL = 13;
export const KEY_BACKSPACE = 14;
export const KEY_TAB = 15;
export const KEY_Q = 16;
export const KEY_W = 17;
export const KEY_E = 18;
export const KEY_R = 19;
export const KEY_T = 20;
export const KEY_Y = 21;
export const KEY_U = 22;
export const KEY_I = 23;
export const KEY_O = 24;
export const KEY_P = 25;
export const KEY_LEFTBRACE = 26;
export const KEY_RIGHTBRACE = 27;
export const KEY_ENTER = 28;
export const KEY_LEFTCTRL = 29;
export const KEY_A = 30;
export const KEY_S = 31;
export const KEY_D = 32;
export const KEY_F = 33;
export const KEY_G = 34;
export const KEY_H = 35;
export const KEY_J = 36;
export const KEY_K = 37;
export const KEY_L = 38;
export const KEY_SEMICOLON = 39;
export const KEY_APOSTROPHE = 40;
export const KEY_GRAVE = 41;
export const KEY_LEFTSHIFT = 42;
export const KEY_BACKSLASH = 43;
export const KEY_Z = 44;
export const KEY_X = 45;
export const KEY_C = 46;
export const KEY_V = 47;
export const KEY_B = 48;
export const KEY_N = 49;
export const KEY_M = 50;
export const KEY_COMMA = 51;
export const KEY_DOT = 52;
export const KEY_SLASH = 53;
export const KEY_RIGHTSHIFT = 54;
export const KEY_KPASTERISK = 55;
export const KEY_LEFTALT = 56;
export const KEY_SPACE = 57;
export const KEY_CAPSLOCK = 58;
export const KEY_F1 = 59;
export const KEY_F2 = 60;
export const KEY_F3 = 61;
export const KEY_F4 = 62;
export const KEY_F5 = 63;
export const KEY_F6 = 64;
export const KEY_F7 = 65;
export const KEY_F8 = 66;
export const KEY_F9 = 67;
export const KEY_F10 = 68;
export const KEY_NUMLOCK = 69;
export const KEY_SCROLLLOCK = 70;
export const KEY_F11 = 87;
export const KEY_F12 = 88;
export const KEY_RIGHTCTRL = 97;
export const KEY_SYSRQ = 99;
export const KEY_RIGHTALT = 100;
export const KEY_HOME = 102;
export const KEY_UP = 103;
export const KEY_PAGEUP = 104;
export const KEY_LEFT = 105;
export const KEY_RIGHT = 106;
export const KEY_END = 107;
export const KEY_DOWN = 108;
export const KEY_PAGEDOWN = 109;
export const KEY_INSERT = 110;
export const KEY_DELETE = 111;
export const KEY_PAUSE = 119;
export const KEY_LEFTMETA = 125;
export const KEY_RIGHTMETA = 126;
export const KEY_MENU = 139;

/**
 * Mouse button evdev codes.
 */
export const BTN_LEFT = 272; // 0x110
export const BTN_RIGHT = 273; // 0x111
export const BTN_MIDDLE = 274; // 0x112

/**
 * Modifier keycode lookup set for fast membership checking.
 */
export const MODIFIER_KEYCODES = new Set<number>([
  KEY_LEFTSHIFT,
  KEY_RIGHTSHIFT,
  KEY_LEFTCTRL,
  KEY_RIGHTCTRL,
  KEY_LEFTALT,
  KEY_RIGHTALT,
  KEY_LEFTMETA,
  KEY_RIGHTMETA,
]);

/**
 * Returns true if the keycode represents a keyboard modifier.
 */
export function isModifierKeycode(code: number): boolean {
  return MODIFIER_KEYCODES.has(code);
}

/**
 * Canonical mapping table from key identifiers and aliases to evdev keycodes.
 */
const KEY_NAME_TO_CODE = new Map<string, number>([
  // Special keys
  ["return", KEY_ENTER],
  ["enter", KEY_ENTER],
  ["backspace", KEY_BACKSPACE],
  ["tab", KEY_TAB],
  ["space", KEY_SPACE],
  [" ", KEY_SPACE],
  ["escape", KEY_ESC],
  ["esc", KEY_ESC],

  // Modifiers
  ["shift", KEY_LEFTSHIFT],
  ["shift_l", KEY_LEFTSHIFT],
  ["leftshift", KEY_LEFTSHIFT],
  ["shift_r", KEY_RIGHTSHIFT],
  ["rightshift", KEY_RIGHTSHIFT],

  ["ctrl", KEY_LEFTCTRL],
  ["control", KEY_LEFTCTRL],
  ["control_l", KEY_LEFTCTRL],
  ["leftctrl", KEY_LEFTCTRL],
  ["ctrl_r", KEY_RIGHTCTRL],
  ["control_r", KEY_RIGHTCTRL],
  ["rightctrl", KEY_RIGHTCTRL],

  ["alt", KEY_LEFTALT],
  ["alt_l", KEY_LEFTALT],
  ["leftalt", KEY_LEFTALT],
  ["option", KEY_LEFTALT],
  ["alt_r", KEY_RIGHTALT],
  ["rightalt", KEY_RIGHTALT],

  ["super", KEY_LEFTMETA],
  ["super_l", KEY_LEFTMETA],
  ["meta", KEY_LEFTMETA],
  ["leftmeta", KEY_LEFTMETA],
  ["win", KEY_LEFTMETA],
  ["cmd", KEY_LEFTMETA],
  ["command", KEY_LEFTMETA],
  ["super_r", KEY_RIGHTMETA],
  ["rightmeta", KEY_RIGHTMETA],

  // Arrows
  ["arrowup", KEY_UP],
  ["up", KEY_UP],
  ["arrowdown", KEY_DOWN],
  ["down", KEY_DOWN],
  ["arrowleft", KEY_LEFT],
  ["left", KEY_LEFT],
  ["arrowright", KEY_RIGHT],
  ["right", KEY_RIGHT],

  // Navigation
  ["pageup", KEY_PAGEUP],
  ["page_up", KEY_PAGEUP],
  ["prior", KEY_PAGEUP],
  ["pagedown", KEY_PAGEDOWN],
  ["page_down", KEY_PAGEDOWN],
  ["next", KEY_PAGEDOWN],
  ["home", KEY_HOME],
  ["end", KEY_END],
  ["delete", KEY_DELETE],
  ["del", KEY_DELETE],
  ["insert", KEY_INSERT],
  ["ins", KEY_INSERT],

  // Locks and system
  ["capslock", KEY_CAPSLOCK],
  ["caps_lock", KEY_CAPSLOCK],
  ["numlock", KEY_NUMLOCK],
  ["num_lock", KEY_NUMLOCK],
  ["scrolllock", KEY_SCROLLLOCK],
  ["scroll_lock", KEY_SCROLLLOCK],
  ["printscreen", KEY_SYSRQ],
  ["print", KEY_SYSRQ],
  ["sysrq", KEY_SYSRQ],
  ["pause", KEY_PAUSE],
  ["menu", KEY_MENU],

  // Function keys
  ["f1", KEY_F1],
  ["f2", KEY_F2],
  ["f3", KEY_F3],
  ["f4", KEY_F4],
  ["f5", KEY_F5],
  ["f6", KEY_F6],
  ["f7", KEY_F7],
  ["f8", KEY_F8],
  ["f9", KEY_F9],
  ["f10", KEY_F10],
  ["f11", KEY_F11],
  ["f12", KEY_F12],

  // Numbers row
  ["0", KEY_0],
  ["1", KEY_1],
  ["2", KEY_2],
  ["3", KEY_3],
  ["4", KEY_4],
  ["5", KEY_5],
  ["6", KEY_6],
  ["7", KEY_7],
  ["8", KEY_8],
  ["9", KEY_9],

  // Alphabet
  ["a", KEY_A],
  ["b", KEY_B],
  ["c", KEY_C],
  ["d", KEY_D],
  ["e", KEY_E],
  ["f", KEY_F],
  ["g", KEY_G],
  ["h", KEY_H],
  ["i", KEY_I],
  ["j", KEY_J],
  ["k", KEY_K],
  ["l", KEY_L],
  ["m", KEY_M],
  ["n", KEY_N],
  ["o", KEY_O],
  ["p", KEY_P],
  ["q", KEY_Q],
  ["r", KEY_R],
  ["s", KEY_S],
  ["t", KEY_T],
  ["u", KEY_U],
  ["v", KEY_V],
  ["w", KEY_W],
  ["x", KEY_X],
  ["y", KEY_Y],
  ["z", KEY_Z],

  // Punctuation and symbols
  ["-", KEY_MINUS],
  ["minus", KEY_MINUS],
  ["=", KEY_EQUAL],
  ["equal", KEY_EQUAL],
  ["[", KEY_LEFTBRACE],
  ["leftbracket", KEY_LEFTBRACE],
  ["]", KEY_RIGHTBRACE],
  ["rightbracket", KEY_RIGHTBRACE],
  [";", KEY_SEMICOLON],
  ["semicolon", KEY_SEMICOLON],
  ["'", KEY_APOSTROPHE],
  ["quote", KEY_APOSTROPHE],
  ["apostrophe", KEY_APOSTROPHE],
  ["`", KEY_GRAVE],
  ["grave", KEY_GRAVE],
  ["backquote", KEY_GRAVE],
  ["\\", KEY_BACKSLASH],
  ["backslash", KEY_BACKSLASH],
  [",", KEY_COMMA],
  ["comma", KEY_COMMA],
  [".", KEY_DOT],
  ["dot", KEY_DOT],
  ["period", KEY_DOT],
  ["/", KEY_SLASH],
  ["slash", KEY_SLASH],
]);

/**
 * Normalizes a key name for lookup.
 */
function normalizeKeyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === " ") {
    return " ";
  }
  return trimmed.toLowerCase().replace(/[-_]+/g, "");
}

/**
 * Resolves an OpenAI key name or character into its Linux evdev keycode.
 * Returns undefined if the key name is not recognized.
 */
export function resolveKeycode(name: string): number | undefined {
  const directMatch = KEY_NAME_TO_CODE.get(name.trim().toLowerCase());
  if (directMatch !== undefined) {
    return directMatch;
  }

  const normalized = normalizeKeyName(name);
  const normalizedMatch = KEY_NAME_TO_CODE.get(normalized);
  if (normalizedMatch !== undefined) {
    return normalizedMatch;
  }

  // Single character check
  if (name.length === 1) {
    const charLower = name.toLowerCase();
    const charMatch = KEY_NAME_TO_CODE.get(charLower);
    if (charMatch !== undefined) {
      return charMatch;
    }
  }

  return undefined;
}

/**
 * Resolves an OpenAI key name into its Linux evdev keycode, throwing an error if unknown.
 */
export function requireKeycode(name: string): number {
  const code = resolveKeycode(name);
  if (code === undefined) {
    throw new Error(`Unknown key name: "${name}"`);
  }
  return code;
}

/**
 * Returns true if the key name represents a modifier key.
 */
export function isModifierKey(name: string): boolean {
  const code = resolveKeycode(name);
  return code !== undefined && isModifierKeycode(code);
}

/**
 * Result of parsing a modifier key combination.
 */
export interface ParsedKeyCombo {
  readonly modifiersDown: readonly number[];
  readonly targetKey: number;
  readonly modifiersUp: readonly number[];
}

/**
 * Splits a combo string like "ctrl+shift+t" or "ctrl++" into tokens.
 */
export function tokenizeKeyCombo(input: string): readonly string[] {
  const trimmed = input.trim();
  if (trimmed === "+") {
    return ["+"];
  }

  // If ending with "++", e.g. "ctrl++"
  if (trimmed.endsWith("++")) {
    const base = trimmed.slice(0, -2);
    const parts = base.split("+").filter((s) => s.length > 0);
    return [...parts, "+"];
  }

  return trimmed.split("+").filter((s) => s.length > 0);
}

/**
 * Parses a key or key combination into modifier press order, target key, and release order.
 * Example:
 *   "ctrl+shift+t" ->
 *     modifiersDown: [KEY_LEFTCTRL, KEY_LEFTSHIFT],
 *     targetKey: KEY_T,
 *     modifiersUp: [KEY_LEFTSHIFT, KEY_LEFTCTRL]
 */
export function parseKeyCombo(keys: string | readonly string[]): ParsedKeyCombo {
  const tokens = typeof keys === "string" ? tokenizeKeyCombo(keys) : keys;

  if (tokens.length === 0) {
    throw new Error("Cannot parse empty key combination");
  }

  const modifiersDown: number[] = [];
  let targetKey: number | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    const code = requireKeycode(token);

    if (isModifierKeycode(code)) {
      // If this is the last token and we haven't found a non-modifier yet,
      // it might be a solo modifier press like "ctrl" or "shift"
      if (i === tokens.length - 1 && targetKey === null && modifiersDown.length === 0) {
        targetKey = code;
      } else {
        modifiersDown.push(code);
      }
    } else {
      if (targetKey !== null) {
        // If multiple non-modifiers, add previous target as a sequence step or replace
        modifiersDown.push(targetKey);
      }
      targetKey = code;
    }
  }

  if (targetKey === null) {
    const lastModifier = modifiersDown.pop();
    if (lastModifier === undefined) {
      throw new Error(`Invalid key combination: ${JSON.stringify(keys)}`);
    }
    targetKey = lastModifier;
  }

  const modifiersUp = [...modifiersDown].reverse();

  return {
    modifiersDown,
    targetKey,
    modifiersUp,
  };
}

/**
 * Character keystroke representation indicating whether Shift must be held.
 */
export interface KeyStroke {
  readonly char: string;
  readonly keycode: number;
  readonly shift: boolean;
}

/**
 * Atomic evdev key state event.
 */
export interface EvdevKeyEvent {
  readonly code: number;
  readonly state: 0 | 1; // 1 = press (down), 0 = release (up)
  readonly description?: string;
}

/**
 * Shifted and unshifted ASCII character mapping table.
 */
const ASCII_KEYSTROKES: ReadonlyMap<string, { readonly keycode: number; readonly shift: boolean }> = new Map([
  // Lowercase
  ["a", { keycode: KEY_A, shift: false }],
  ["b", { keycode: KEY_B, shift: false }],
  ["c", { keycode: KEY_C, shift: false }],
  ["d", { keycode: KEY_D, shift: false }],
  ["e", { keycode: KEY_E, shift: false }],
  ["f", { keycode: KEY_F, shift: false }],
  ["g", { keycode: KEY_G, shift: false }],
  ["h", { keycode: KEY_H, shift: false }],
  ["i", { keycode: KEY_I, shift: false }],
  ["j", { keycode: KEY_J, shift: false }],
  ["k", { keycode: KEY_K, shift: false }],
  ["l", { keycode: KEY_L, shift: false }],
  ["m", { keycode: KEY_M, shift: false }],
  ["n", { keycode: KEY_N, shift: false }],
  ["o", { keycode: KEY_O, shift: false }],
  ["p", { keycode: KEY_P, shift: false }],
  ["q", { keycode: KEY_Q, shift: false }],
  ["r", { keycode: KEY_R, shift: false }],
  ["s", { keycode: KEY_S, shift: false }],
  ["t", { keycode: KEY_T, shift: false }],
  ["u", { keycode: KEY_U, shift: false }],
  ["v", { keycode: KEY_V, shift: false }],
  ["w", { keycode: KEY_W, shift: false }],
  ["x", { keycode: KEY_X, shift: false }],
  ["y", { keycode: KEY_Y, shift: false }],
  ["z", { keycode: KEY_Z, shift: false }],

  // Uppercase (shifted)
  ["A", { keycode: KEY_A, shift: true }],
  ["B", { keycode: KEY_B, shift: true }],
  ["C", { keycode: KEY_C, shift: true }],
  ["D", { keycode: KEY_D, shift: true }],
  ["E", { keycode: KEY_E, shift: true }],
  ["F", { keycode: KEY_F, shift: true }],
  ["G", { keycode: KEY_G, shift: true }],
  ["H", { keycode: KEY_H, shift: true }],
  ["I", { keycode: KEY_I, shift: true }],
  ["J", { keycode: KEY_J, shift: true }],
  ["K", { keycode: KEY_K, shift: true }],
  ["L", { keycode: KEY_L, shift: true }],
  ["M", { keycode: KEY_M, shift: true }],
  ["N", { keycode: KEY_N, shift: true }],
  ["O", { keycode: KEY_O, shift: true }],
  ["P", { keycode: KEY_P, shift: true }],
  ["Q", { keycode: KEY_Q, shift: true }],
  ["R", { keycode: KEY_R, shift: true }],
  ["S", { keycode: KEY_S, shift: true }],
  ["T", { keycode: KEY_T, shift: true }],
  ["U", { keycode: KEY_U, shift: true }],
  ["V", { keycode: KEY_V, shift: true }],
  ["W", { keycode: KEY_W, shift: true }],
  ["X", { keycode: KEY_X, shift: true }],
  ["Y", { keycode: KEY_Y, shift: true }],
  ["Z", { keycode: KEY_Z, shift: true }],

  // Digits
  ["1", { keycode: KEY_1, shift: false }],
  ["2", { keycode: KEY_2, shift: false }],
  ["3", { keycode: KEY_3, shift: false }],
  ["4", { keycode: KEY_4, shift: false }],
  ["5", { keycode: KEY_5, shift: false }],
  ["6", { keycode: KEY_6, shift: false }],
  ["7", { keycode: KEY_7, shift: false }],
  ["8", { keycode: KEY_8, shift: false }],
  ["9", { keycode: KEY_9, shift: false }],
  ["0", { keycode: KEY_0, shift: false }],

  // Shifted symbols
  ["!", { keycode: KEY_1, shift: true }],
  ["@", { keycode: KEY_2, shift: true }],
  ["#", { keycode: KEY_3, shift: true }],
  ["$", { keycode: KEY_4, shift: true }],
  ["%", { keycode: KEY_5, shift: true }],
  ["^", { keycode: KEY_6, shift: true }],
  ["&", { keycode: KEY_7, shift: true }],
  ["*", { keycode: KEY_8, shift: true }],
  ["(", { keycode: KEY_9, shift: true }],
  [")", { keycode: KEY_0, shift: true }],
  ["_", { keycode: KEY_MINUS, shift: true }],
  ["+", { keycode: KEY_EQUAL, shift: true }],
  ["{", { keycode: KEY_LEFTBRACE, shift: true }],
  ["}", { keycode: KEY_RIGHTBRACE, shift: true }],
  ["|", { keycode: KEY_BACKSLASH, shift: true }],
  [":", { keycode: KEY_SEMICOLON, shift: true }],
  ['"', { keycode: KEY_APOSTROPHE, shift: true }],
  ["<", { keycode: KEY_COMMA, shift: true }],
  [">", { keycode: KEY_DOT, shift: true }],
  ["?", { keycode: KEY_SLASH, shift: true }],
  ["~", { keycode: KEY_GRAVE, shift: true }],

  // Unshifted symbols & whitespace
  [" ", { keycode: KEY_SPACE, shift: false }],
  ["\t", { keycode: KEY_TAB, shift: false }],
  ["\n", { keycode: KEY_ENTER, shift: false }],
  ["\r", { keycode: KEY_ENTER, shift: false }],
  ["-", { keycode: KEY_MINUS, shift: false }],
  ["=", { keycode: KEY_EQUAL, shift: false }],
  ["[", { keycode: KEY_LEFTBRACE, shift: false }],
  ["]", { keycode: KEY_RIGHTBRACE, shift: false }],
  ["\\", { keycode: KEY_BACKSLASH, shift: false }],
  [";", { keycode: KEY_SEMICOLON, shift: false }],
  ["'", { keycode: KEY_APOSTROPHE, shift: false }],
  ["`", { keycode: KEY_GRAVE, shift: false }],
  [",", { keycode: KEY_COMMA, shift: false }],
  [".", { keycode: KEY_DOT, shift: false }],
  ["/", { keycode: KEY_SLASH, shift: false }],
]);

/**
 * Converts a single character into a KeyStroke specifying keycode and shift requirement.
 */
export function charToKeyStroke(char: string): KeyStroke {
  const match = ASCII_KEYSTROKES.get(char);
  if (match !== undefined) {
    return {
      char,
      keycode: match.keycode,
      shift: match.shift,
    };
  }

  throw new Error(`Unsupported character in string typer: "${char}" (code: ${char.charCodeAt(0)})`);
}

/**
 * Decomposes an arbitrary text string into an array of keystrokes.
 */
export function decomposeText(text: string): readonly KeyStroke[] {
  const strokes: KeyStroke[] = [];
  for (const char of text) {
    strokes.push(charToKeyStroke(char));
  }
  return strokes;
}

/**
 * Decomposes arbitrary text into atomic evdev key down and key up event sequences.
 * Shift press/release is handled for shifted symbols and uppercase characters.
 */
export function textToKeyEvents(text: string): readonly EvdevKeyEvent[] {
  const events: EvdevKeyEvent[] = [];
  const strokes = decomposeText(text);

  for (const stroke of strokes) {
    if (stroke.shift) {
      events.push({ code: KEY_LEFTSHIFT, state: 1, description: "Shift down" });
      events.push({ code: stroke.keycode, state: 1, description: `'${stroke.char}' down` });
      events.push({ code: stroke.keycode, state: 0, description: `'${stroke.char}' up` });
      events.push({ code: KEY_LEFTSHIFT, state: 0, description: "Shift up" });
    } else {
      events.push({ code: stroke.keycode, state: 1, description: `'${stroke.char}' down` });
      events.push({ code: stroke.keycode, state: 0, description: `'${stroke.char}' up` });
    }
  }

  return events;
}
