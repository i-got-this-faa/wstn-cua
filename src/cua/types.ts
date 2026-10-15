import { z } from "zod";

/**
 * Coordinate represents a 2D pixel position [x, y] in the Weston desktop viewport.
 * Screen origin (0, 0) is top-left.
 */
export const CoordinateSchema = z.tuple([z.number(), z.number()]);
export type Coordinate = z.infer<typeof CoordinateSchema>;

/**
 * Branded Screen Coordinate type to prevent primitive confusion.
 */
export type ScreenCoordinate = [number, number] & { readonly __brand: "ScreenCoordinate" };

/**
 * Safely constructs a validated ScreenCoordinate.
 */
export function createScreenCoordinate(x: number, y: number): ScreenCoordinate {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`Coordinates must be finite numbers: received [${x}, ${y}]`);
  }
  return [Math.round(x), Math.round(y)] as ScreenCoordinate;
}

/**
 * Mouse button identifiers supported by the CUA protocol.
 */
export const MouseButtonSchema = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

// Individual Action Schemas

export const ClickActionSchema = z.object({
  action: z.literal("click"),
  coordinate: CoordinateSchema,
  button: MouseButtonSchema.optional(),
  modifiers: z.array(z.string()).optional(),
});
export type ClickAction = z.infer<typeof ClickActionSchema>;

export const DoubleClickActionSchema = z.object({
  action: z.literal("double_click"),
  coordinate: CoordinateSchema,
});
export type DoubleClickAction = z.infer<typeof DoubleClickActionSchema>;

export const TripleClickActionSchema = z.object({
  action: z.literal("triple_click"),
  coordinate: CoordinateSchema,
});
export type TripleClickAction = z.infer<typeof TripleClickActionSchema>;

export const MiddleClickActionSchema = z.object({
  action: z.literal("middle_click"),
  coordinate: CoordinateSchema,
});
export type MiddleClickAction = z.infer<typeof MiddleClickActionSchema>;

export const RightClickActionSchema = z.object({
  action: z.literal("right_click"),
  coordinate: CoordinateSchema,
});
export type RightClickAction = z.infer<typeof RightClickActionSchema>;

export const MouseDownActionSchema = z.object({
  action: z.literal("mouse_down"),
  button: MouseButtonSchema.optional(),
  coordinate: CoordinateSchema.optional(),
});
export type MouseDownAction = z.infer<typeof MouseDownActionSchema>;

export const MouseUpActionSchema = z.object({
  action: z.literal("mouse_up"),
  button: MouseButtonSchema.optional(),
  coordinate: CoordinateSchema.optional(),
});
export type MouseUpAction = z.infer<typeof MouseUpActionSchema>;

export const MoveActionSchema = z.object({
  action: z.literal("move"),
  coordinate: CoordinateSchema,
});
export type MoveAction = z.infer<typeof MoveActionSchema>;

export const DragActionSchema = z.object({
  action: z.literal("drag"),
  start: CoordinateSchema,
  end: CoordinateSchema,
  path: z.array(CoordinateSchema).optional(),
});
export type DragAction = z.infer<typeof DragActionSchema>;

export const TypeActionSchema = z.object({
  action: z.literal("type"),
  text: z.string(),
});
export type TypeAction = z.infer<typeof TypeActionSchema>;

export const KeypressActionSchema = z.object({
  action: z.literal("keypress"),
  keys: z.union([z.string(), z.array(z.string())]),
});
export type KeypressAction = z.infer<typeof KeypressActionSchema>;

export const KeyDownActionSchema = z.object({
  action: z.literal("key_down"),
  key: z.string(),
});
export type KeyDownAction = z.infer<typeof KeyDownActionSchema>;

export const KeyUpActionSchema = z.object({
  action: z.literal("key_up"),
  key: z.string(),
});
export type KeyUpAction = z.infer<typeof KeyUpActionSchema>;

export const ScrollActionSchema = z.object({
  action: z.literal("scroll"),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  coordinate: CoordinateSchema.optional(),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const WaitActionSchema = z.object({
  action: z.literal("wait"),
  duration_ms: z.number().nonnegative(),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

export const ScreenshotActionSchema = z.object({
  action: z.literal("screenshot"),
});
export type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;

/**
 * Discriminated union of all OpenAI Computer Use Agent actions.
 */
export const CUAActionSchema = z.discriminatedUnion("action", [
  ClickActionSchema,
  DoubleClickActionSchema,
  TripleClickActionSchema,
  MiddleClickActionSchema,
  RightClickActionSchema,
  MouseDownActionSchema,
  MouseUpActionSchema,
  MoveActionSchema,
  DragActionSchema,
  TypeActionSchema,
  KeypressActionSchema,
  KeyDownActionSchema,
  KeyUpActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  ScreenshotActionSchema,
]);
export type CUAAction = z.infer<typeof CUAActionSchema>;

/**
 * Action discriminant literal names.
 */
export const CUA_ACTION_NAMES = [
  "click",
  "double_click",
  "triple_click",
  "middle_click",
  "right_click",
  "mouse_down",
  "mouse_up",
  "move",
  "drag",
  "type",
  "keypress",
  "key_down",
  "key_up",
  "scroll",
  "wait",
  "screenshot",
] as const;
export type CUAActionName = (typeof CUA_ACTION_NAMES)[number];

/**
 * Live streaming portal feed information.
 */
export const LiveFeedInfoSchema = z.object({
  portal_url: z.string(),
  stream_url: z.string(),
  frame_id: z.number().optional(),
});
export type LiveFeedInfo = z.infer<typeof LiveFeedInfoSchema>;

/**
 * Execution result returned for every executed CUA action.
 */
export const CUAActionResultSchema = z.object({
  status: z.enum(["success", "error"]),
  action: z.string(),
  duration_ms: z.number(),
  live_feed: LiveFeedInfoSchema.optional(),
  error: z.string().optional(),
});
export type CUAActionResult = z.infer<typeof CUAActionResultSchema>;

/**
 * OpenAI Tool Declaration specification.
 */
export interface OpenAIToolDefinition {
  readonly type: "computer_use";
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
  readonly meta?: {
    readonly coordinate_system: {
      readonly origin: "top-left";
      readonly unit: "pixel";
      readonly default_resolution: { readonly width: number; readonly height: number };
    };
    readonly endpoints: {
      readonly portal_url: string;
      readonly stream_url: string;
      readonly webrtc_url?: string;
      readonly screenshot_url?: string;
    };
  };
}

/**
 * OpenAI CUA Tool Definition for wstn desktop automation.
 */
export const OPENAI_CUA_TOOL_DEFINITION = {
  type: "computer_use",
  name: "computer_use",
  description: "Execute mouse, keyboard, and screen capture actions in a standalone Weston Wayland desktop session.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: CUA_ACTION_NAMES,
        description: "The computer use action to perform.",
      },
      coordinate: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        description: "Screen coordinate [x, y] in pixels. Origin (0,0) is top-left.",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button for click or mouse_down/mouse_up. Defaults to 'left'.",
      },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: "Keyboard modifier keys to hold during action (e.g., ['ctrl', 'shift']).",
      },
      start: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        description: "Drag start coordinate [x, y].",
      },
      end: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        description: "Drag end coordinate [x, y].",
      },
      path: {
        type: "array",
        items: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
        description: "Optional intermediate waypoints [x, y] along drag path.",
      },
      text: {
        type: "string",
        description: "Text string to type into the focused window.",
      },
      keys: {
        description: "Key or key combination to press (e.g. 'ctrl+c', 'Return', ['ctrl', 'shift', 't']).",
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      key: {
        type: "string",
        description: "Individual key name to press or release.",
      },
      delta_x: {
        type: "number",
        description: "Horizontal scroll displacement in pixels or ticks.",
      },
      delta_y: {
        type: "number",
        description: "Vertical scroll displacement in pixels or ticks. Negative scrolls up, positive scrolls down.",
      },
      duration_ms: {
        type: "number",
        description: "Wait duration in milliseconds.",
      },
    },
    required: ["action"],
  },
  meta: {
    coordinate_system: {
      origin: "top-left",
      unit: "pixel",
      default_resolution: { width: 1280, height: 800 },
    },
    endpoints: {
      portal_url: "/portal",
      stream_url: "/portal/stream",
      webrtc_url: "/portal/webrtc",
      screenshot_url: "/portal/screenshot",
    },
  },
} as const satisfies OpenAIToolDefinition;

/**
 * Type guard for CUAAction.
 */
export function isCUAAction(value: unknown): value is CUAAction {
  return CUAActionSchema.safeParse(value).success;
}

/**
 * Boundary parser for CUAAction, throwing ZodError if invalid.
 */
export function parseCUAAction(value: unknown): CUAAction {
  return CUAActionSchema.parse(value);
}

/**
 * Boundary safe parser for CUAAction.
 */
export function safeParseCUAAction(value: unknown): z.SafeParseReturnType<unknown, CUAAction> {
  return CUAActionSchema.safeParse(value);
}
