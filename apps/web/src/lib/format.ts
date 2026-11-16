import { useTranslation } from "react-i18next";

/**
 * Dates, times and numbers in the page's language, never the browser's default locale: use these
 * instead of `toLocale*` or `Intl` without a locale.
 */
export function formatters(language: string) {
  return {
    /** A date and time, by default "medium" date and "short" time. */
    dateTime: (date: Date | number | string, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) =>
      new Intl.DateTimeFormat(language, options).format(new Date(date)),
    /** A date and time down to the second. */
    dateTimeSeconds: (date: Date | number | string) => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(date)),
    date: (date: Date | number | string, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) => new Intl.DateTimeFormat(language, options).format(new Date(date)),
    time: (date: Date | number | string, options: Intl.DateTimeFormatOptions = { timeStyle: "short" }) => new Intl.DateTimeFormat(language, options).format(new Date(date)),
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(language, options).format(value),
    /** Names joined as the language writes a list: "A, B and C". */
    list: (items: string[]) => new Intl.ListFormat(language, { type: "conjunction" }).format(items),
    /** Names joined as the language writes a choice: "A, B or C". */
    listOr: (items: string[]) => new Intl.ListFormat(language, { type: "disjunction" }).format(items),
  };
}

/** The formatters of the page's current language, and a file size in its units. */
export function useFormat() {
  const { t, i18n } = useTranslation();
  const format = formatters(i18n.language);
  const size = (bytes: number) => {
    if (bytes < 1024) return t("size.bytes", { size: format.number(bytes) });
    if (bytes < 1024 * 1024) return t("size.kb", { size: format.number(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
    return t("size.mb", { size: format.number(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  };
  /** How long from `from` to `to` (or until now): "1 h 2 min", "3 min 4 s" or "5 s". */
  const duration = (from: Date, to: Date | null) => {
    const s = Math.max(0, Math.round(((to ?? new Date()).getTime() - from.getTime()) / 1000));
    if (s >= 3600) return t("duration.hours", { hours: format.number(Math.floor(s / 3600)), minutes: format.number(Math.floor((s % 3600) / 60)) });
    if (s >= 60) return t("duration.minutes", { minutes: format.number(Math.floor(s / 60)), seconds: format.number(s % 60) });
    return t("duration.seconds", { seconds: format.number(s) });
  };
  return { ...format, size, duration };
}
