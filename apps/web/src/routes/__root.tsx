/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { createI18n } from "../lib/i18n.ts";
import { themeInitScript } from "../lib/theme.ts";
import { getAuthState } from "../server/session.ts";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  // Once per navigation, for every route: the guards below read it from the context, and the page
  // renders in its language from the first server render on.
  beforeLoad: async () => ({ auth: await getAuthState() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Dispand" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  // The shell renders even when the guard failed, so the error shows in a whole page.
  shellComponent: RootShell,
  component: RootComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  // Undefined only when `getAuthState` failed: the error page is in English.
  const language = Route.useRouteContext({ select: (context) => (context as { auth?: { language: "en" | "fr" } }).auth?.language ?? "en" });
  const [i18n] = useState(() => createI18n(language));
  // A new language from the server (a sign-in, a saved choice) after the first render.
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);
  return (
    <I18nextProvider i18n={i18n}>
      <Document>{children}</Document>
    </I18nextProvider>
  );
}

function Document({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <html lang={i18n.language} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
