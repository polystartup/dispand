import { diffArrays } from "diff";

// A skill file in conflict goes to Stem whole while the Job's prompt can hold it. A long one goes
// as its changed parts: the plugin's old file is diffed with the owner's and with the plugin's new
// one, and each run of lines that either changed, with a few lines around it, is a part, given as
// its three texts. The lines between the parts are the same in all three and stay as they are.
// Stem answers with each part's merged text, put back in order between them: the file's whole
// merged text, which then applies or waits for the owner as any merged text does. No line is
// merged by the code (a three-way merge library would take the changes made on one side alone),
// so Stem still decides every change, as when it reads the whole file.

/** A part of a long file: the same lines in the plugin's old file, the owner's and the plugin's new one. */
export type Part = { old: string; mine: string; next: string };
/** A file cut for Stem: the text the three files share, and the parts they don't, in order. */
export type Segment = string | Part;

/** The lines shown around each change. */
const CONTEXT = 3;
/** Beyond this many lines added and removed on one side, the file isn't cut: it goes whole. */
const MAX_EDITS = 2_000;

/** A text's lines, each with its line end, so that joining them gives the text back. */
const linesOf = (text: string) => text.split(/(?<=\n)/).filter(Boolean);

/** The three texts cut into what they share and their parts; null when a side changed too much to cut. */
export function fileParts(old: string, mine: string, next: string): Segment[] | null {
  const o = linesOf(old);
  const sides = [linesOf(mine), linesOf(next)];
  // A line of the old file is touched when a side removed it, or added lines right after it (before the first line: that one).
  const touched = new Uint8Array(o.length);
  // Where each side keeps each line of the old file (-1: it doesn't).
  const at: Int32Array[] = [];
  for (const side of sides) {
    const changes = diffArrays(o, side, { maxEditLength: MAX_EDITS });
    if (!changes) return null;
    const to = new Int32Array(o.length).fill(-1);
    let i = 0;
    let j = 0;
    for (const c of changes) {
      if (c.removed) {
        touched.fill(1, i, i + c.count);
        i += c.count;
      } else if (c.added) {
        touched[Math.max(0, i - 1)] = 1;
        j += c.count;
      } else for (const end = i + c.count; i < end; ) to[i++] = j++;
    }
    at.push(to);
  }
  // Lines within CONTEXT of a touched one are in a part; the others are kept by both sides, in order.
  const near = new Uint8Array(o.length);
  for (let i = 0; i < o.length; i++) if (touched[i]) near.fill(1, Math.max(0, i - CONTEXT), i + CONTEXT + 1);
  const all = [o, ...sides];
  const segments: Segment[] = [];
  let from = [0, 0, 0];
  const part = (to: number[]) => {
    const [old, mine, next] = all.map((lines, k) => lines.slice(from[k], to[k]).join(""));
    if (old || mine || next) segments.push({ old: old!, mine: mine!, next: next! });
  };
  for (let i = 0; i < o.length; ) {
    if (near[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < o.length && !near[end]) end++;
    part([i, at[0]![i]!, at[1]![i]!]);
    segments.push(o.slice(i, end).join(""));
    from = [end, at[0]![end - 1]! + 1, at[1]![end - 1]! + 1];
    i = end;
  }
  part(all.map((lines) => lines.length));
  return segments;
}

/**
 * The whole text from each part's merged text, in order; null when there isn't one text per part.
 * A text missing its last line end before shared lines gets one, so the lines don't run together.
 */
export function joinParts(segments: Segment[], texts: string[]): string | null {
  if (texts.length !== segments.filter((s) => typeof s !== "string").length) return null;
  let k = 0;
  return segments
    .map((s, i) => {
      if (typeof s === "string") return s;
      const text = texts[k++]!;
      return text && !text.endsWith("\n") && i < segments.length - 1 ? `${text}\n` : text;
    })
    .join("");
}
