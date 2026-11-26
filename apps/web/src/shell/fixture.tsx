// The shell the web tests build in (`vitest.config.ts`, the `shell` project) and CI builds the app
// with once: it fills every place of the contract, which it imports by its path, as an embedding
// build's shell would import `@dispand/web/shell`.
import { useState } from "react";
import type { AccountMenuProps, Shell, SignInProps, WorkspaceSwitcherProps } from "./contract.ts";

/** The places the tests make throw, to see their fallbacks. */
export const failing = { workspaceSwitcher: false, accountMenu: false, signIn: false };

function WorkspaceSwitcher({ workspaces, current, switchTo, createWorkspace, t }: WorkspaceSwitcherProps) {
  const [refused, setRefused] = useState<string | null>(null);
  if (failing.workspaceSwitcher) throw new Error("The fixture's switcher failed.");
  return (
    <div>
      <p>{t("fixture.switcher", { name: current.name })}</p>
      {workspaces.map((x) => (
        <button key={x.workspaceId} type="button" onClick={() => switchTo(x.workspaceId)}>
          {x.name}
        </button>
      ))}
      <button type="button" onClick={() => createWorkspace("Gamma").catch((error: { data?: { key?: string } }) => setRefused(String(error.data?.key)))}>
        {t("fixture.create")}
      </button>
      {refused && <p role="alert">{refused}</p>}
    </div>
  );
}

function AccountMenu({ workspace, Item, t }: AccountMenuProps) {
  if (failing.accountMenu) throw new Error("The fixture's account menu failed.");
  return <Item href={`/fixture?organization=${encodeURIComponent(workspace.organizationId)}`}>{t("fixture.entry")}</Item>;
}

function SignIn({ invitation, t }: SignInProps) {
  if (failing.signIn) throw new Error("The fixture's sign-in failed.");
  return <p>{t("fixture.signIn", { invitation: String(invitation) })}</p>;
}

export default {
  workspaceSwitcher: WorkspaceSwitcher,
  accountMenu: AccountMenu,
  signIn: SignIn,
  messages: {
    en: {
      "fixture.switcher": "Fixture switcher in {{name}}",
      "fixture.create": "Create Gamma",
      "fixture.entry": "Fixture entry",
      "fixture.signIn": "Fixture sign-in, invitation {{invitation}}",
      "fixture.refused": "Refused by the fixture.",
      // A public key: it keeps its public text.
      "workspace.managerOnly": "The fixture's text, never shown.",
    },
    fr: {
      "fixture.switcher": "Sélecteur de la fixture dans {{name}}",
      "fixture.create": "Créer Gamma",
      "fixture.entry": "Entrée de la fixture",
      "fixture.signIn": "Connexion de la fixture, invitation {{invitation}}",
      "fixture.refused": "Refusé par la fixture.",
    },
  },
} satisfies Shell;
