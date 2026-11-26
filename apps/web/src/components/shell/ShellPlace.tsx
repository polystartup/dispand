import { Component, Suspense, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ShellText } from "../../shell/contract.ts";

// One small boundary rather than a package: it only swaps in a fallback, and retries on request.
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A place the build's shell fills (`#web-shell`), or `fallback` when it throws. In the browser the
 * boundary catches it. A server render doesn't reach class boundaries: there the `Suspense` around
 * the place renders the fallback instead of failing the page, and the browser renders the place
 * again. `fallback` gets `retry`, which mounts the place anew.
 */
export function ShellPlace({ fallback, children }: { fallback: (retry: () => void) => ReactNode; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const shown = fallback(() => setAttempt((x) => x + 1));
  return (
    <Boundary key={attempt} fallback={shown}>
      <Suspense fallback={shown}>{children}</Suspense>
    </Boundary>
  );
}

/** The page's translator for the `messages` namespace, as a shell's places take it; values are only text to insert. */
export function useShellText(): ShellText {
  const { t } = useTranslation("messages");
  const text = t as unknown as (key: string, options: object) => string;
  return (key, values = {}) => text(key, { replace: values, ...(typeof values.count === "number" && { count: values.count }) });
}
