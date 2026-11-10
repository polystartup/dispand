// Keyboard moves between the grid's cells, pure so they are tested without a browser.

export type GridPos = { row: number; col: number };
export type GridKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Tab" | "ShiftTab" | "Enter";

const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(max - 1, 0));

/** The cell a key moves to: arrows and Enter clamp at the edges; Tab wraps to the next row's first cell. */
export function nextCell(pos: GridPos, key: GridKey, size: { rows: number; cols: number }): GridPos {
  const { row, col } = pos;
  switch (key) {
    case "ArrowUp":
      return { row: clamp(row - 1, size.rows), col };
    case "ArrowDown":
    case "Enter":
      return { row: clamp(row + 1, size.rows), col };
    case "ArrowLeft":
      return { row, col: clamp(col - 1, size.cols) };
    case "ArrowRight":
      return { row, col: clamp(col + 1, size.cols) };
    case "Tab":
      if (col < size.cols - 1) return { row, col: col + 1 };
      return row < size.rows - 1 ? { row: row + 1, col: 0 } : pos;
    case "ShiftTab":
      if (col > 0) return { row, col: col - 1 };
      return row > 0 ? { row: row - 1, col: size.cols - 1 } : pos;
  }
}
