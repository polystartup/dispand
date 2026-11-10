import { z } from "zod";
import { Sort } from "../data/query.ts";

// Pure: imported by the web widgets too (`@dispand/domain/pages/config`).

/** The most fields a Grid or Table widget shows. */
export const MAX_WIDGET_FIELDS = 20;

const FieldIds = z.array(z.string().max(64)).min(1).max(MAX_WIDGET_FIELDS);

/** A Grid widget: cards showing these fields (the first is the title), with a cover image. */
export const GridConfig = z.object({ fieldIds: FieldIds, coverFieldId: z.string().max(64).optional() });
export type GridConfig = z.infer<typeof GridConfig>;

/** A Table widget: these columns, in the default order `sort` gives. */
export const TableConfig = z.object({ fieldIds: FieldIds, sort: Sort.optional() });
export type TableConfig = z.infer<typeof TableConfig>;

export type WidgetConfig = GridConfig | TableConfig;
