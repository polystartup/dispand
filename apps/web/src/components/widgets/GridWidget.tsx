import type { Cell, FieldSchema } from "@dispand/domain/data/fields";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";
import { fileUrl } from "../data/AttachmentCell.tsx";
import { DataWidgetSettings } from "../dashboard/DataWidgetSettings.tsx";
import { type DataWidget, DataWidgetFrame, dataNotice, OpenInData, useDataWidget, WidgetCell } from "./data-widget.tsx";

const LIMIT = 100;

/** A card's title: its first field as plain text. */
export function titleOf(field: FieldSchema, value: Cell | undefined, checked: string): string {
  if (value === undefined || value === null || Array.isArray(value)) return "";
  if (field.type === "single-select") return field.choices.find((c) => c.id === value)?.label ?? "";
  if (field.type === "checkbox") return value === true ? checked : "";
  return String(value).split("\n")[0]!;
}

/** The rows of a table as cards: the first chosen field is the title, the others follow, and a files field can be the cover. */
export function GridWidget({ widget, editing }: { widget: Extract<DataWidget, { type: "grid" }>; editing: boolean }) {
  const { t } = useTranslation(["dashboard", "common", "data"]);
  const { table, shown, all } = useDataWidget(widget);
  const notice = dataNotice(t, table, shown);
  const cover = all.find((f) => f.id === widget.config.coverFieldId && f.type === "attachment");
  return (
    <DataWidgetFrame widget={widget} editing={editing} extra={<DataWidgetSettings widget={widget} />} notice={notice ?? undefined}>
      {/* Only with a field to title the cards: the notice shows otherwise. */}
      {shown[0] && <Cards tableId={widget.tableId} title={shown[0]} rest={shown.slice(1)} cover={cover} />}
    </DataWidgetFrame>
  );
}

function Cards({ tableId, title, rest, cover }: { tableId: string; title: FieldSchema; rest: FieldSchema[]; cover?: FieldSchema }) {
  const { t } = useTranslation(["dashboard", "common", "data"]);
  const rows = useQuery(orpc.rows.list.queryOptions({ input: { tableId, limit: LIMIT } }));
  if (rows.error && !rows.data) {
    return (
      <p role="alert" className="px-5 pb-5 text-[14px] text-muted">
        {t("widget.rowsFailed")}
      </p>
    );
  }
  if (!rows.data) return <p className="px-5 pb-5 text-[14px] text-faint">{t("common:loading")}</p>;
  const { data } = rows;
  return (
    <>
      <ul className="grid flex-1 content-start gap-3 overflow-auto px-5 pb-2 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {data.rows.map((row) => {
          const image = cover && (row.values[cover.id] as string[] | undefined)?.find((id) => data.attachments[id]?.image);
          return (
            <li key={row.id} className="overflow-hidden rounded-xl border border-line">
              {image && <img src={fileUrl(image)} alt={data.attachments[image]?.name ?? ""} className="aspect-video w-full object-cover" />}
              <div className="grid gap-1.5 p-3 text-[14px]">
                <p className="truncate font-medium">{titleOf(title, row.values[title.id], t("data:cell.checked")) || <span className="text-faint">{t("widget.untitled")}</span>}</p>
                {rest.map((field) => {
                  const value = row.values[field.id] ?? null;
                  const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
                  return empty ? null : (
                    <div key={field.id} className="grid gap-0.5">
                      <span className="text-[12px] text-muted">{field.name}</span>
                      <div className="line-clamp-3 break-words">
                        <WidgetCell field={field} value={value} files={data.attachments} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      {data.rows.length === 0 && <p className="px-5 pb-2 text-[14px] text-muted">{t("widget.noRows")}</p>}
      <OpenInData tableId={tableId} shown={data.rows.length} total={data.total} />
    </>
  );
}
