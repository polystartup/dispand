import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "./parts.tsx";

export type OAuthStatus = "authorize" | "connected" | "reauthorize";

type Props = {
  status: OAuthStatus;
  /** The client id the owner entered, if any (its secret is never shown). */
  clientId: string | null;
  busy?: boolean;
  /** The last Connect failed for want of a client id: its fields are shown. */
  askClient?: boolean;
  /** Starts the sign-in, with the client the owner entered (or `null` to remove it); the page then leaves for the server's. */
  onConnect: (client?: { clientId: string; clientSecret?: string } | null) => void;
};

const said: Record<OAuthStatus, { text: string; tone: string; action: string }> = {
  authorize: { text: "Not connected yet: sign in to the server to list its actions.", tone: "text-muted", action: "Connect" },
  connected: { text: "Connected.", tone: "text-muted", action: "Re-authorize" },
  reauthorize: { text: "The sign-in stopped working: its calls fail until you sign in again.", tone: "text-danger", action: "Re-authorize" },
};

/**
 * An OAuth tool's sign-in: where it stands, Connect or Re-authorize, and the client id and secret
 * an authorization server gave the owner, for one that supports neither metadata documents nor
 * registration.
 */
export function ToolSignIn({ status, clientId, busy, askClient, onConnect }: Props) {
  const [unfolded, setOpen] = useState(clientId !== null);
  const open = unfolded || askClient === true;
  const [id, setId] = useState(clientId ?? "");
  const [secret, setSecret] = useState("");
  const { text, tone, action } = said[status];

  function connect() {
    const entered = id.trim();
    if (!open) return onConnect();
    if (!entered) return onConnect(clientId === null ? undefined : null);
    // The same id with no new secret keeps the one stored.
    if (entered === clientId && !secret.trim()) return onConnect();
    onConnect({ clientId: entered, ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
  }

  return (
    <section aria-labelledby="tool-sign-in" className="space-y-3">
      <h2 id="tool-sign-in" className="text-[15px] font-medium">
        Sign-in
      </h2>
      <p role="status" className={`text-[13px] ${tone}`}>
        {text}
      </p>
      {open ? (
        <div className="space-y-3">
          <FormField label="Client id" htmlFor="tool-client-id" hint="Only for a server that gave you one: most need none.">
            <Input id="tool-client-id" value={id} onChange={(e) => setId(e.target.value)} maxLength={500} autoComplete="off" />
          </FormField>
          <FormField label="Client secret" htmlFor="tool-client-secret" hint={clientId ? "Set: leave empty to keep." : "If the server gave one."}>
            <Input id="tool-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={2000} autoComplete="off" />
          </FormField>
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Enter a client id
        </Button>
      )}
      <Button type="button" disabled={busy} onClick={connect}>
        {action}
      </Button>
    </section>
  );
}
