import { Filter, type RowQuery, Sort } from "@dispand/domain/data/query";

// A table's sort and filter live in its URL only (no saved views): `?q=<RowQuery as JSON>` and
// `?row=<id>` for the open row. A link that no longer fits (a field deleted, an op renamed)
// still opens the table: what doesn't parse is dropped.

export type DataSearch = { q?: string; row?: string };

const MAX_FILTERS = 20;
const MAX_SORTS = 3;

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseDataSearch(search: unknown): { query: RowQuery; row?: string } {
  const s = (typeof search === "object" && search !== null ? search : {}) as Record<string, unknown>;
  let q: unknown = s.q;
  if (typeof q === "string") {
    try {
      q = JSON.parse(q);
    } catch {
      q = null;
    }
  }
  const raw = (typeof q === "object" && q !== null ? q : {}) as Record<string, unknown>;
  const filters = listOf(raw.filters).flatMap((f) => {
    const parsed = Filter.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
  const sort = listOf(raw.sort).flatMap((f) => {
    const parsed = Sort.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
  const query = { filters: filters.slice(0, MAX_FILTERS), sort: sort.slice(0, MAX_SORTS) };
  return typeof s.row === "string" ? { query, row: s.row } : { query };
}

export function toDataSearch(query: RowQuery, row?: string): DataSearch {
  const empty = query.filters.length === 0 && query.sort.length === 0;
  return { ...(!empty && { q: JSON.stringify({ filters: query.filters, sort: query.sort }) }), ...(row && { row }) };
}
