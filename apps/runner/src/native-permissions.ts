import { type Answer, type CliRule, type CliRuleCall, matchesRule, parseRule } from "@dispand/runner-protocol";

/** Pure session-local policy. The caller enforces the runner boundary before using a grant. */
export function nativePermissions(cli: CliRuleCall["cli"], rules?: { allow: string[]; deny: string[] }) {
  const parsed = (sources: string[]) => sources.flatMap((source) => { const rule = parseRule(cli, source); return rule ? [rule] : []; });
  let allow = parsed(rules?.allow ?? []);
  let deny = parsed(rules?.deny ?? []);
  return {
    decision(call: CliRuleCall): "allow" | "deny" | null {
      if (deny.some((rule) => matchesRule(rule, call))) return "deny";
      return allow.some((rule) => matchesRule(rule, call)) ? "allow" : null;
    },
    remember(source: string, call: CliRuleCall, answer: Answer | null) {
      if (answer?.kind !== "permission" || !answer.remember || answer.decision === "allow-always") return;
      const rule = parseRule(cli, source);
      if (!rule || !matchesRule(rule, call)) return;
      const same = (other: CliRule) => JSON.stringify(other) === JSON.stringify(rule);
      allow = allow.filter((other) => !same(other));
      deny = deny.filter((other) => !same(other));
      (answer.decision === "allow" ? allow : deny).push(rule);
    },
  };
}

/** Only a rule that actually matches the shown call may be offered to the owner. */
export function nativeRuleForCall(call: CliRuleCall, suggestions: string[] = []): string | null {
  const candidates = [...suggestions];
  if (call.cli === "claude-code") {
    if (call.tool === "Bash" && call.command !== undefined) candidates.push(`Bash(${call.command})`);
    else if (["Edit", "Write", "NotebookEdit"].includes(call.tool)) candidates.push(call.tool);
    else if (call.tool === "WebFetch" && call.url) {
      try { candidates.push(`WebFetch(domain:${new URL(call.url).hostname})`); } catch { /* No domain offer for an invalid URL. */ }
    }
  } else {
    if (call.tool === "Shell" && call.command !== undefined) {
      if (call.proposedExecpolicyAmendment) candidates.push(`Shell:${JSON.stringify(call.proposedExecpolicyAmendment)}`);
      candidates.push(`Shell=${call.command}`);
    } else if (call.tool === "FileChange") candidates.push("FileChange");
  }
  return candidates.find((source) => { const rule = parseRule(call.cli, source); return rule !== null && matchesRule(rule, call); }) ?? null;
}
