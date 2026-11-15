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
    date: (date: Date | number | string, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) => new Intl.DateTimeFormat(language, options).format(new Date(date)),
    time: (date: Date | number | string, options: Intl.DateTimeFormatOptions = { timeStyle: "short" }) => new Intl.DateTimeFormat(language, options).format(new Date(date)),
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(language, options).format(value),
    /** Names joined as the language writes a list: "A, B and C". */
    list: (items: string[]) => new Intl.ListFormat(language, { type: "conjunction" }).format(items),
  };
}

/** The formatters of the page's current language. */
export function useFormat() {
  return formatters(useTranslation().i18n.language);
}
