/**
 * The web shell: an optional module, chosen at build time with `DISPAND_WEB_SHELL` (a path
 * relative to `apps/web`, or absolute), whose default export fills some of the places below. The
 * packed `@dispand/web` exports these types as `@dispand/web/shell`, so a shell typechecks against
 * the app it is built into. Without the variable, the build has no shell (`none.ts`).
 *
 * The module and what it imports live under `apps/web`, outside gitignored folders: its `react`
 * is then the app's copy, and Tailwind compiles its classes.
 *
 * Limits:
 * - At run time a shell imports `react` and nothing else. It imports this file with `import type`
 *   only, which the build erases.
 * - It adds no routes and no packages.
 * - It calls the API only through the actions its places hand it.
 * - The page policy (`server/page-security.ts`) is unchanged, and a shell can't change it:
 *   `fetch` to the app's own paths works (`connect-src 'self'`); a third-party script or frame
 *   doesn't (`script-src 'self'`, `frame-src 'none'`), and neither does a form posted to another
 *   origin (`form-action 'self'`).
 * - A place that renders on the server never reads browser globals while rendering.
 * - Each component place renders inside its own error boundary: a place that throws, on the
 *   server too, renders as if there were no shell, except `signIn`, which shows a retryable error.
 */
import type { ComponentType, ReactNode } from "react";

/** A workspace the person can open, as `workspace.mine` lists it. */
export type ShellWorkspace = { organizationId: string; workspaceId: string; name: string; role: "owner" | "manager" | "member" };

/** The signed-in person. */
export type ShellPerson = { name: string; email: string };

/** A key of the page's `messages` catalog (public keys and the shell's own) in the page's language. */
export type ShellText = (key: string, values?: Record<string, string | number>) => string;

export type WorkspaceSwitcherProps = {
  workspaces: ShellWorkspace[];
  current: ShellWorkspace;
  switchTo: (workspaceId: string) => void;
  /**
   * Creates a workspace named `name` in `current`'s organization, then switches to it. Only the
   * organization's owner may: anyone else gets the refusal. Rejects with the API's error as the
   * page's client throws it (an `ORPCError`: `message` in the page's language, `code`, and
   * `data.key` when the server gave one).
   */
  createWorkspace: (name: string) => Promise<void>;
  t: ShellText;
};

export type AccountMenuProps = {
  workspace: ShellWorkspace;
  person: ShellPerson;
  /** One entry of the account menu: a plain link, opened with a full page load. */
  Item: ComponentType<{ href: string; children: ReactNode }>;
  t: ShellText;
};

export type SignInProps = {
  /** The invitation's token on the invitation page's sign-in; null on the sign-in page. */
  invitation: string | null;
  t: ShellText;
};

/** The default export of the module `DISPAND_WEB_SHELL` names. Every place is optional. */
export type Shell = {
  /** Replaces the sidebar's workspace switcher, shown with a single workspace too. */
  workspaceSwitcher?: ComponentType<WorkspaceSwitcherProps>;
  /** Entries of the account menu, in a section of their own after Profile. */
  accountMenu?: ComponentType<AccountMenuProps>;
  /** Takes over the sign-in form of the sign-in page and of the invitation page; it finishes its own navigation. */
  signIn?: ComponentType<SignInProps>;
  /** Flat dotted keys per language, the shape `registerMessages` takes. A public key keeps its public text. */
  messages?: Partial<Record<"en" | "fr", Record<string, string>>>;
};
