import type { FieldType } from "@dispand/domain/data/fields";
import { useTranslation } from "react-i18next";
import { Calendar, CircleChevronDown, Hash, Link, Link2, type LucideIcon, Paperclip, SquareCheck, TextAlignStart, Type } from "lucide-react";

/** How each field type is drawn in the Data screens; its name is `useFieldTypeLabel`. */
export const FIELD_TYPE_UI: Record<FieldType, { Icon: LucideIcon }> = {
  text: { Icon: Type },
  "long-text": { Icon: TextAlignStart },
  number: { Icon: Hash },
  checkbox: { Icon: SquareCheck },
  date: { Icon: Calendar },
  url: { Icon: Link },
  attachment: { Icon: Paperclip },
  "single-select": { Icon: CircleChevronDown },
  reference: { Icon: Link2 },
};

/** A field type's name in the page's language. */
export function useFieldTypeLabel() {
  const { t } = useTranslation("data");
  return (type: FieldType) => t(`fieldType.${type}`);
}
