import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePendingQuestionsStream } from "../components/shell/NotificationsBell.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";
import { getAuthState } from "../server/session.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const { needsSetup, user } = await getAuthState();
    if (needsSetup) throw redirect({ to: "/setup" });
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AppShell,
});

function AppShell() {
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

  return (
    <TooltipProvider delayDuration={400}>
      {/* One Sheet around trigger and content, so Radix returns focus to the trigger on close. */}
      <Sheet open={open} onOpenChange={setOpen}>
      <div className="min-h-dvh md:pl-64">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-sidebar px-3 backdrop-blur-xl backdrop-saturate-150 md:hidden">
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="Open menu"
              className="grid size-9 place-items-center rounded-lg text-fg transition hover:bg-hover"
            >
              <Menu size={20} aria-hidden />
            </button>
          </SheetTrigger>
          <span className="text-[15px] font-semibold tracking-tight">Dispand</span>
        </header>

        <aside
          aria-label="Sidebar"
          className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line bg-sidebar backdrop-blur-2xl backdrop-saturate-150 md:block"
        >
          <Sidebar user={user} onNavigate={() => {}} />
        </aside>

          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-64 max-w-[85vw] gap-0 border-0 bg-sidebar p-0 backdrop-blur-2xl backdrop-saturate-150 md:hidden"
          >
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Navigation</SheetDescription>
            <Sidebar user={user} onNavigate={() => setOpen(false)} />
          </SheetContent>

        <main className={assistant ? "flex h-[calc(100dvh-3rem)] min-h-0 flex-col overflow-hidden md:h-dvh" : "mx-auto max-w-4xl px-5 py-8 md:px-12 md:py-14"}>
          <Outlet />
        </main>
      </div>
      </Sheet>
    </TooltipProvider>
  );
}
