import { useTranslation } from "react-i18next";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-[15px] text-muted">{subtitle}</p>}
    </header>
  );
}

/** Screen that is not built yet. */
export function Placeholder({ title, subtitle }: { title: string; subtitle?: string }) {
  const { t } = useTranslation("dashboard");
  return (
    <>
      <PageHeader title={title} />
      <div className="grid place-items-center rounded-2xl bg-surface px-6 py-16 text-center shadow-card">
        <p className="text-[17px] font-medium">{t("placeholder.soon")}</p>
        <p className="mt-1 max-w-sm text-[14px] text-muted">{subtitle ?? t("placeholder.soonText")}</p>
      </div>
    </>
  );
}
