// Compiled, never run (`check.sh`): an embedding build's shell typechecks against the packed
// `@dispand/web/shell`, and a place with the wrong props is refused.
import type { AccountMenuProps, Shell, SignInProps, WorkspaceSwitcherProps } from "@dispand/web/shell";

declare const switcher: (props: WorkspaceSwitcherProps) => null;
declare const accountMenu: (props: AccountMenuProps) => null;
declare const signIn: (props: SignInProps) => null;

export const shell: Shell = { workspaceSwitcher: switcher, accountMenu, signIn, messages: { fr: { "shell.key": "Texte" } } };

// @ts-expect-error a place's props are the contract's
export const wrong: Shell = { signIn: (props: { invitation: number }) => props && null };
