import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import { readTheme, saveTheme, type Theme } from "../../lib/theme.ts";

const options = [
  { value: "system", label: "theme.system", Icon: Monitor },
  { value: "light", label: "theme.light", Icon: Sun },
  { value: "dark", label: "theme.dark", Icon: Moon },
] as const;

/** Theme choice (System, Light, Dark) as a radio group inside the user menu. */
export function ThemeToggle() {
  const { t } = useTranslation("shell");
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(readTheme()), []);

  return (
    <>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{t("theme.label")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => {
          setTheme(value as Theme);
          saveTheme(value as Theme);
        }}
      >
        {options.map(({ value, label, Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon aria-hidden /> {t(label)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
