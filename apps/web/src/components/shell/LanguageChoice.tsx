import { useRouter } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { saveLanguage } from "../../lib/auth-call.ts";
import type { Language } from "../../lib/i18n.ts";

const options = ["browser", "en", "fr"] as const;

/** The page language, saved for the user: their browser's (the default), English or French. */
export function LanguageChoice({ saved }: { saved: Language | null }) {
  const { t } = useTranslation("shell");
  const router = useRouter();
  const [error, setError] = useState(false);
  return (
    <>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{t("language.label")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={saved ?? "browser"}
        onValueChange={async (value) => {
          setError(false);
          try {
            await saveLanguage(value === "browser" ? null : (value as Language));
          } catch {
            setError(true);
            return;
          }
          // The guards' context holds the saved choice and the page's language: read them again.
          await router.invalidate();
        }}
      >
        {options.map((value) => (
          <DropdownMenuRadioItem key={value} value={value} onSelect={(event) => event.preventDefault()}>
            {value === "browser" && <Globe aria-hidden />} {t(`language.${value}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {error && (
        <p role="alert" className="px-2 pt-1 text-xs text-destructive">
          {t("language.failed")}
        </p>
      )}
    </>
  );
}
