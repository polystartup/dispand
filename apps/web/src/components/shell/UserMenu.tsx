import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "../../lib/auth-call.ts";
import { unsubscribeDevice } from "../../lib/push.ts";
import type { Language } from "../../lib/i18n.ts";
import { LanguageChoice } from "./LanguageChoice.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

/** Signed-in user at the bottom of the sidebar: theme and language overrides, and sign out. */
export function UserMenu({ user }: { user: { name: string; email: string; language: Language | null } }) {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const [error, setError] = useState(false);

  return (
    <DropdownMenu onOpenChange={() => setError(false)}>
      <DropdownMenuTrigger
        aria-label={t("account.menu")}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-hover data-[state=open]:bg-hover"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-semibold text-accent-foreground">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{user.name}</span>
        <ChevronsUpDown size={14} className="text-faint" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56 rounded-xl border-0 p-2 shadow-pop">
        <DropdownMenuLabel className="pb-2 font-normal">
          <div className="truncate text-[13px] font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeToggle />
        <DropdownMenuSeparator />
        <LanguageChoice saved={user.language} />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async (event) => {
            event.preventDefault(); // stay open to show a failure, and to retry
            setError(false);
            try {
              // While still signed in: the server forgets this browser's push subscription.
              await unsubscribeDevice();
              await signOut();
            } catch {
              setError(true);
              return;
            }
            await navigate({ to: "/login" });
          }}
        >
          <LogOut aria-hidden /> {t("account.signOut")}
        </DropdownMenuItem>
        {error && (
          <p role="alert" className="px-2 pt-1 text-xs text-destructive">
            {t("account.signOutFailed")}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
