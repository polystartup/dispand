import type { FieldType } from "@dispand/domain/data/fields";
import { Calendar, CircleChevronDown, Hash, Link, type LucideIcon, Paperclip, SquareCheck, TextAlignStart, Type } from "lucide-react";

/** How each field type is named and drawn in the Data screens. */
export const FIELD_TYPE_UI: Record<FieldType, { label: string; Icon: LucideIcon }> = {
  text: { label: "Text", Icon: Type },
  "long-text": { label: "Long text", Icon: TextAlignStart },
  number: { label: "Number", Icon: Hash },
  checkbox: { label: "Checkbox", Icon: SquareCheck },
  date: { label: "Date", Icon: Calendar },
  url: { label: "URL", Icon: Link },
  attachment: { label: "Files", Icon: Paperclip },
  "single-select": { label: "Single select", Icon: CircleChevronDown },
};
