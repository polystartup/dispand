import type { Page } from "@playwright/test";

/** Content the Audit acceptance (yz-audit.spec.ts) drives through a Job: zzz-telemetry.spec.ts checks no Audit row or export holds it. */
export const AUDIT_SENTINELS = { auditMail: "sentinel-audit-mail-41", auditRow: "sentinel-audit-row-42", auditMemory: "sentinel-audit-memory-43", auditDraft: "sentinel-audit-draft-44", chatMessage: "sentinel-chat-message-45", ownWordsAnswer: "sentinel-question-answer-46" };

export type AuditRow = { action: string; result: string; jobId: string | null; traceId: string | null; resourceType: string; resourceId: string | null; details: Record<string, unknown> };

/** Every Audit row of the signed-in owner, newest first, page after page. */
export async function auditRows(page: Page): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await page.request.post("/api/rpc/audit/list", { headers: { "x-csrf-token": "orpc" }, data: { json: cursor ? { cursor } : {} } });
    if (!res.ok()) throw new Error(`audit/list: ${res.status()}`);
    const listed = ((await res.json()) as { json: { rows: AuditRow[]; next: string | null } }).json;
    rows.push(...listed.rows);
    cursor = listed.next ?? undefined;
  } while (cursor);
  return rows;
}
