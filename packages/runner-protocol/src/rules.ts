import { storable } from "./bounds.ts";

export const MAX_CLI_RULE_LENGTH = 1000;
export type CliRule =
  | { cli: "claude-code"; kind: "tool"; tool: "Bash" | "Edit" | "Write" | "NotebookEdit" }
  | { cli: "claude-code"; kind: "domain"; domain: string }
  | { cli: "claude-code" | "codex"; kind: "exact"; command: string }
  | { cli: "claude-code" | "codex"; kind: "prefix"; words: string[] }
  | { cli: "codex"; kind: "tool"; tool: "FileChange" };

export interface CliRuleCall {
  cli: "claude-code" | "codex";
  tool: string;
  command?: string;
  url?: string;
  proposedExecpolicyAmendment?: readonly string[];
  commandActions?: readonly unknown[];
}

// A deliberately small literal shell subset. Quotes, expansions, redirects, comments,
// operators and non-ASCII whitespace require an exact-command rule instead.
function literalWords(command: string): string[] | null {
  const words = command.replace(/^[ \t]+|[ \t]+$/g, "").split(/[ \t]+/);
  return words.every((word) => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(word)) ? words : null;
}

/** Parse Dispand's rule subset, never a CLI settings file or an executable expression. */
export function parseRule(cli: string, source: string): CliRule | null {
  if (!source || source.length > MAX_CLI_RULE_LENGTH || !storable(source)) return null;
  if (cli === "claude-code") {
    if (source === "Bash" || source === "Edit" || source === "Write" || source === "NotebookEdit") return { cli, kind: "tool", tool: source };
    if (source.startsWith("Bash(") && source.endsWith(")")) {
      const command = source.slice(5, -1);
      if (!command.trim()) return null;
      if (command.endsWith(":*")) {
        const words = literalWords(command.slice(0, -2));
        return words ? { cli, kind: "prefix", words } : null;
      }
      return { cli, kind: "exact", command };
    }
    const domain = /^WebFetch\(domain:([a-zA-Z0-9.-]+)\)$/.exec(source)?.[1];
    if (domain && domain.length <= 253 && domain.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return { cli, kind: "domain", domain: domain.toLowerCase() };
  } else if (cli === "codex") {
    if (source === "FileChange") return { cli, kind: "tool", tool: source };
    if (source.startsWith("Shell=") && source.slice(6).trim()) return { cli, kind: "exact", command: source.slice(6) };
    if (source.startsWith("Shell:")) {
      try {
        const words: unknown = JSON.parse(source.slice(6));
        if (Array.isArray(words) && words.length > 0 && words.every((word): word is string => typeof word === "string" && literalWords(word)?.length === 1 && literalWords(word)?.[0] === word)) return { cli, kind: "prefix", words };
      } catch { /* An invalid rule offers no permission. */ }
    }
  }
  return null;
}

/** The caller must enforce roots, settings-file exclusions and other boundary checks first. */
export function matchesRule(rule: CliRule, call: CliRuleCall): boolean {
  if (rule.cli !== call.cli) return false;
  if (rule.kind === "tool") return rule.tool === call.tool;
  if (rule.kind === "domain") {
    if (call.tool !== "WebFetch" || !call.url) return false;
    try {
      const url = new URL(call.url);
      return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.toLowerCase() === rule.domain;
    } catch { return false; }
  }
  if (call.tool !== (rule.cli === "codex" ? "Shell" : "Bash") || call.command === undefined) return false;
  if (rule.kind === "exact") return rule.command === call.command;
  if (rule.cli === "codex" && (call.commandActions?.length !== 1 || call.proposedExecpolicyAmendment?.length !== rule.words.length || !rule.words.every((word, index) => call.proposedExecpolicyAmendment?.[index] === word))) return false;
  const words = literalWords(call.command);
  return words !== null && words.length >= rule.words.length && rule.words.every((word, index) => words[index] === word);
}
