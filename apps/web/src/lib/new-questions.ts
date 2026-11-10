/** The questions in `items` not seen before; remembers them. The first call (`seen` null) only learns. */
export function takeNew<T extends { id: string }>(seen: Set<string> | null, items: T[]): { seen: Set<string>; fresh: T[] } {
  const next = seen ?? new Set<string>();
  const fresh = seen ? items.filter((q) => !seen.has(q.id)) : [];
  for (const q of items) next.add(q.id);
  return { seen: next, fresh };
}
