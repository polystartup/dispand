import { z } from "zod";

// Pure: imported by the web dashboard too (`@dispand/domain/pages/layout`).

export const BREAKPOINTS = ["lg", "md", "sm"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Minimum container width (px) of each breakpoint, and its columns. */
export const GRID = {
  breakpoints: { lg: 760, md: 480, sm: 0 },
  cols: { lg: 12, md: 8, sm: 1 },
} as const satisfies Record<string, Record<Breakpoint, number>>;

export const GridPos = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1),
  h: z.number().int().min(1).max(100),
});
export type GridPos = z.infer<typeof GridPos>;

export type WidgetLayout = Record<Breakpoint, GridPos>;

/** Whether the item fits its breakpoint's columns. */
export function fits(bp: Breakpoint, pos: GridPos): boolean {
  return pos.x + pos.w <= GRID.cols[bp];
}

/** What a new widget is, for its size: a chat conversation, a workflow's button, or rows of a table. */
export type WidgetSize = "chat" | "button" | "data";

const SIZES = {
  chat: { w: { lg: 12, md: 8 }, h: 11 },
  data: { w: { lg: 12, md: 8 }, h: 10 },
  button: { w: { lg: 6, md: 4 }, h: 4 },
} as const;

/** Where a new widget goes: below everything; a chat or data widget gets the full width and more height, a button half. */
export function placeBelow(existing: WidgetLayout[], size: WidgetSize): WidgetLayout {
  const { w, h } = SIZES[size];
  const below = (bp: Breakpoint) => Math.max(0, ...existing.map((l) => l[bp].y + l[bp].h));
  return {
    lg: { x: 0, y: below("lg"), w: w.lg, h },
    md: { x: 0, y: below("md"), w: w.md, h },
    sm: { x: 0, y: below("sm"), w: 1, h },
  };
}
