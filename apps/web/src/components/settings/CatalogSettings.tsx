import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import { errorMessage, type Tool } from "./ToolSheet.tsx";

/**
 * A catalog tool's settings (its key), as its entry names them: where its owner signs in when
 * the tool was added without them (through a proposal, say). Values are sealed on the server and
 * never shown again. Nothing for an entry without settings.
 */
export function CatalogSettings({ tool, onSaved }: { tool: Tool; onSaved: (tool: Tool) => void }) {
  const catalog = useQuery(orpc.tools.catalog.queryOptions({ input: {} }));
  const entry = catalog.data?.find((e) => e.id === tool.catalogId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const fill = useMutation(orpc.tools.fillSettings.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() }) }));
  if (entry?.kind !== "http" || entry.settings.length === 0) return null;

  async function save() {
    setError(null);
    try {
      onSaved(await fill.mutateAsync({ id: tool.id, settings: values }));
      setValues({});
    } catch (e) {
      setError(errorMessage(e, "Could not save the settings."));
    }
  }

  return (
    <section aria-labelledby="tool-settings" className="space-y-3">
      <h2 id="tool-settings" className="text-[15px] font-medium">
        Sign-in
      </h2>
      <p role="status" className={`text-[13px] ${tool.signIn === "needed" ? "text-danger" : "text-muted"}`}>
        {tool.signIn === "needed" ? `Needs sign-in: enter its ${entry.settings.map((s) => s.label).join(" and ")} to use it. Until then nothing calls it.` : "Connected. Enter new settings to replace them."}
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {entry.settings.map((s) => (
          <FormField key={s.key} label={s.label} htmlFor={`tool-setting-${s.key}`} hint={`${s.help} Stored encrypted; it is never shown again.`}>
            <Input
              id={`tool-setting-${s.key}`}
              type="password"
              autoComplete="off"
              value={values[s.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
              maxLength={4000}
              required
            />
          </FormField>
        ))}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={fill.isPending}>
          Save settings
        </Button>
      </form>
    </section>
  );
}
