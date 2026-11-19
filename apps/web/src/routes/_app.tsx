import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { usePendingQuestionsStream } from "../components/shell/NotificationsBell.tsx";
import { ChatSessionsProvider } from "../lib/chat-sessions.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => {
    const { needsSetup, user } = context.auth;
    if (needsSetup) throw redirect({ to: "/setup" });
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AppShell,
});

function AppShell() {
  const { t } = useTranslation("shell");
  const { user } = Route.useRouteContext();
  const assistant = useRouterState({ select: (state) => state.location.pathname === "/assistant" });
  const [open, setOpen] = useState(false);
  usePendingQuestionsStream();

  // The sheet is a mobile-only dialog: close it when the viewport becomes desktop-sized.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const onChange = () => desktop.matches && setOpen(false);
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  // One Sheet around trigger and content, so Radix returns focus to the trigger on close.
  return (
      <ChatSessionsProvider key={user.email}>
      <Sheet open={open} onOpenChange={setOpen}>
      <div className="min-h-dvh md:pl-64">
        <header className={`sticky top-0 z-20 flex h-12 items-center gap-2 bg-surface px-3 md:hidden ${open ? "" : "spectrum-header"}`}>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label={t("openMenu")}
              className="grid size-11 place-items-center rounded-lg text-fg transition hover:bg-hover"
            >
              <Menu size={20} aria-hidden />
            </button>
          </SheetTrigger>
          <span className="text-xl font-semibold tracking-[-0.03em] lowercase">Dispand</span>
        </header>

        <aside
          aria-label={t("sidebar")}
          className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line bg-sidebar backdrop-blur-2xl backdrop-saturate-150 md:block"
        >
          <Sidebar user={user} onNavigate={() => {}} />
        </aside>

          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-64 max-w-[85vw] gap-0 border-0 bg-sidebar p-0 backdrop-blur-2xl backdrop-saturate-150 md:hidden"
          >
            <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
            <SheetDescription className="sr-only">{t("navigation")}</SheetDescription>
            <Sidebar user={user} onNavigate={() => setOpen(false)} />
          </SheetContent>

        <main className={assistant ? "flex h-[calc(100dvh-3rem)] min-h-0 flex-col overflow-hidden md:h-dvh" : "mx-auto max-w-4xl px-5 py-8 md:px-12 md:py-14"}>
          <Outlet />
        </main>
      </div>
      </Sheet>
      </ChatSessionsProvider>
  );
}
