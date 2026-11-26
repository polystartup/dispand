import shell from "#web-shell";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import { useState, type ReactNode } from "react";
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
import type { ShellWorkspace } from "../../shell/contract.ts";
import { LanguageChoice } from "./LanguageChoice.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";
import { ShellPlace, useShellText } from "./ShellPlace.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

/** One entry of a shell's account menu: a plain link, opened with a full page load. */
function ShellItem({ href, children }: { href: string; children: ReactNode }) {
  return (
    <DropdownMenuItem asChild>
      <a href={href}>{children}</a>
    </DropdownMenuItem>
  );
}

/** The build's shell's entries (`accountMenu`), in a section of their own; none without a tab's workspace, or when they fail. */
function ShellEntries({ workspace, person }: { workspace: ShellWorkspace | undefined; person: { name: string; email: string } }) {
  const t = useShellText();
  const { accountMenu: Place } = shell;
  if (!Place || !workspace) return null;
  return (
    <ShellPlace fallback={() => null}>
      <DropdownMenuSeparator />
      <Place workspace={workspace} person={person} Item={ShellItem} t={t} />
    </ShellPlace>
  );
}

/** Signed-in user at the bottom of the sidebar: theme and language overrides, and sign out. `workspace`: the tab's, for a shell's entries. */
export function UserMenu({ user, workspace }: { user: { name: string; email: string; language: Language | null }; workspace?: ShellWorkspace }) {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const [profile, setProfile] = useState(false);

  return (
    <>
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
          <DropdownMenuItem onSelect={() => setProfile(true)}>
            <UserRound aria-hidden /> {t("account.profile")}
          </DropdownMenuItem>
          <ShellEntries workspace={workspace} person={{ name: user.name, email: user.email }} />
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
              // The next person to sign in on this page must not read this one's cached answers.
              queryClient.clear();
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
      <ProfileDialog open={profile} onOpenChange={setProfile} />
    </>
  );
}
