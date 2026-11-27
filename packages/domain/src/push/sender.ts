import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { generateRequestDetails, type PushSubscription, type RequestOptions, WebPushError } from "web-push";
import type { Db } from "../db/client.ts";
import { agents, pushDeliveries, pushSubscriptions, questions, runs, user, workflows, workspaces } from "../db/schema.ts";
import { detached, eachScope, inScope, type Scope, SYSTEM } from "../db/scope.ts";
import { ANY_WORKSPACE, type Engine } from "../engine/engine.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";
import { errorKind, logError } from "../log.ts";
import { type Language, rendered } from "../messages/index.ts";
import type { SecretBox } from "../secrets.ts";
import { inSpan, meter, recordError, tracer } from "../telemetry/index.ts";
import { authorize } from "../workspace/authorize.ts";
import { subscriptionKeysAad, vapidKeys } from "./keys.ts";

const traces = tracer("push");
const counts = meter("push");

/** Items asked within this window after the first go as one push, with their count. */
export const WINDOW_MS = 10_000;
/** A device that failed is tried again after this, while its items still wait, then twice as late each time, up to `MAX_RETRY_MS`. */
export const RETRY_MS = 60_000;
export const MAX_RETRY_MS = 3_600_000;

/** How long to wait after the `failures`-th flush in a row that left a device failed. */
export const retryDelay = (failures: number, base = RETRY_MS) => Math.min(base * 2 ** Math.max(0, failures - 1), Math.max(base, MAX_RETRY_MS));

/**
 * What a push carries through the browser vendor's push service: a sentence naming the agent and
 * the item's kind, how many items it stands for, and the newest one's random id. Never a
 * question's text or a proposal's items.
 */
export type PushPayload = { text: string; count: number; itemId: string };

/** How long a push service has to answer. */
export const TIMEOUT_MS = 15_000;

export type Send = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

/**
 * Posts a push through `fetch` (the app's address-guarded one in production, as for tools): `web-push`
 * encrypts and signs it, and its answer is never read, only its status, within `TIMEOUT_MS`.
 */
export function pushVia(fetch: typeof globalThis.fetch): Send {
  return async (subscription, payload, options) => {
    const request = generateRequestDetails(subscription, payload, options);
    // fetch sets the length itself.
    const headers = Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length").map(([name, value]) => [name, String(value)] as [string, string]);
    const response = await fetch(request.endpoint, { method: request.method, headers, body: request.body as Uint8Array<ArrayBuffer>, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await response.body?.cancel();
    if (!response.ok) throw new WebPushError("The push service refused the push", response.status, {}, "", request.endpoint);
  };
}

type Options = {
  /** The VAPID subject: the app's https URL, or a `mailto:`. */
  subject: string;
  /** How a push is posted: `pushVia(fetch)` by default. */
  send?: Send;
  windowMs?: number;
  retryMs?: number;
};

/** What waits: a pending Inbox item (never a consult) whose addressee has a device made before it was asked, that it hasn't reached. */
const waiting = and(eq(questions.status, "pending"), ne(questions.kind, "consult"), isNull(pushDeliveries.questionId));
const reaching = and(eq(pushSubscriptions.ownerId, questions.addresseeId), gt(questions.createdAt, pushSubscriptions.createdAt));
const reached = and(eq(pushDeliveries.questionId, questions.id), eq(pushDeliveries.subscriptionId, pushSubscriptions.id));

/** Each workspace's recipients with an item waiting (`waitingItems`), as scopes, read under SYSTEM. */
export function pushTargets(db: Db): Promise<Scope[]> {
  return inScope(SYSTEM, () =>
    db
      // Never null here: `reaching` joins on it.
      .selectDistinct({ organizationId: workspaces.organizationId, workspaceId: workspaces.id, userId: sql<string>`${questions.addresseeId}` })
      .from(questions)
      .innerJoin(pushSubscriptions, reaching)
      .innerJoin(runs, eq(runs.id, questions.runId))
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .leftJoin(pushDeliveries, reached)
      .where(waiting),
  );
}

/** Every pending Inbox item with every subscription it hasn't reached and that was made before it was asked, newest first. */
function waitingItems(db: Db) {
  return db
    .select({
      organizationId: workspaces.organizationId,
      workspaceId: workspaces.id,
      itemId: questions.id,
      kind: questions.kind,
      route: questions.route,
      agentName: jobAgentNameSql,
      builtIn: agents.builtIn,
      workflowName: workflows.name,
      subscriptionId: pushSubscriptions.id,
      ownerId: pushSubscriptions.ownerId,
      endpoint: pushSubscriptions.endpoint,
      keys: pushSubscriptions.keys,
      language: pushSubscriptions.language,
      chosen: user.language,
    })
    .from(questions)
    .innerJoin(pushSubscriptions, reaching)
    .innerJoin(user, eq(user.id, questions.addresseeId))
    .innerJoin(runs, eq(runs.id, questions.runId))
    .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(workflows, eq(workflows.id, runs.workflowId))
    .leftJoin(pushDeliveries, reached)
    .where(waiting)
    .orderBy(desc(questions.createdAt), desc(questions.id));
}

type Waiting = Awaited<ReturnType<typeof waitingItems>>[number];

/**
 * Sends every pending Inbox item (a Question or an Approval, never a consult) to every
 * subscription made before it was asked and not yet sent it. What was sent is a row
 * (`push_deliveries`), so a restart sends what waited, once: woken by `questionChanges`, and at start.
 */
export class PushSender {
  private timer: NodeJS.Timeout | undefined;
  private due = 0;
  /** Flushes in a row that left a device failed (the backoff). */
  private failures = 0;
  private running: Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();

  constructor(
    private readonly db: Db,
    private readonly engine: Pick<Engine, "questionChanges" | "checkEscalation">,
    private readonly secrets: SecretBox,
    private readonly options: Options,
  ) {}

  start(): void {
    const changes = this.engine.questionChanges.subscribe(ANY_WORKSPACE, { signal: this.stopping.signal });
    void (async () => {
      try {
        for await (const change of changes) {
          void change;
          this.wake();
        }
      } catch {
        // Aborted by `stop()`.
      }
    })();
    // What waited while the app was down.
    this.wake();
  }

  /** Flushes after `delay`, or sooner when already due sooner: what comes meanwhile goes in the same push. */
  wake(delay = this.options.windowMs ?? WINDOW_MS): void {
    const at = Date.now() + delay;
    if (this.stopping.signal.aborted || (this.timer && this.due <= at)) return;
    clearTimeout(this.timer);
    this.due = at;
    // With no scope, whoever woke it (a Job's question, a request), then under SYSTEM: a flush
    // spans every workspace and splits itself by recipient (`eachScope`).
    this.timer = setTimeout(detached(() => {
      this.timer = undefined;
      void inScope(SYSTEM, () => this.flush());
    }), delay);
    this.timer.unref();
  }

  /** Sends what waits now, one flush at a time. */
  flush(): Promise<void> {
    this.running = this.running
      .then(() => this.sendWaiting())
      .catch((err: unknown) => {
        logError("push.flush failed", err);
        this.wake(retryDelay(++this.failures, this.options.retryMs));
      });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    clearTimeout(this.timer);
    await this.running;
  }

  private sendWaiting(): Promise<void> {
    return inSpan(traces, "push.flush", {}, errorKind, async (span) => {
      let items = 0;
      const outcomes: string[] = [];
      // Per workspace and recipient (`eachScope`); once, as is, on a single-tenant database.
      await eachScope(this.db, pushTargets, async () => {
        const waiting = await waitingItems(this.db);
        items += waiting.length;
        if (waiting.length === 0) return;
        // One push per device and workspace: each workspace's items go only once its access is checked.
        const byDevice = new Map<string, Waiting[]>();
        for (const row of waiting) {
          const key = `${row.subscriptionId}\u0000${row.workspaceId}`;
          byDevice.set(key, [...(byDevice.get(key) ?? []), row]);
        }
        const vapid = await vapidKeys(this.db, this.secrets);
        outcomes.push(...(await Promise.all([...byDevice.values()].map((group) => this.sendOne(group, vapid)))));
      });
      span.setAttribute("dispand.push.items", items);
      if (items === 0) {
        // Nothing waits: a streak of failures is over.
        this.failures = 0;
        return;
      }
      if (outcomes.includes("failed")) this.wake(retryDelay(++this.failures, this.options.retryMs));
      else this.failures = 0;
    });
  }

  /** One push to one subscription for its waiting items (newest first): sent, gone (404 or 410: deleted), or failed (tried again). */
  private async sendOne(waiting: Waiting[], vapid: { publicKey: string; privateKey: string }): Promise<string> {
    // Check at use, on every flush, retries included: an escalation whose addressee may no longer
    // be asked moves on (`checkEscalation`), and reaches its new addressee on the next flush instead.
    const items: Waiting[] = [];
    for (const item of waiting) if (!item.route || (await this.engine.checkEscalation(item.itemId, { type: "scheduler" })) === item.ownerId) items.push(item);
    const newest = items[0];
    if (!newest) return "skipped";
    // The recipient's role now, read on every flush, retries included: a person removed from the workspace gets nothing more.
    if (!(await authorize(this.db, newest.ownerId, newest.organizationId, newest.workspaceId))) return "skipped";
    return traces.startActiveSpan("push.send", { attributes: { "dispand.push.subscription": newest.subscriptionId, "dispand.push.count": items.length } }, async (span) => {
      let outcome = "sent";
      try {
        // The language the user chose in Settings, else the one that browser shows.
        const language = (newest.chosen ?? newest.language) as Language;
        const agent = newest.builtIn === "assistant" ? rendered(language, "agent.assistant.name") : (newest.agentName ?? newest.workflowName ?? "");
        const kind = newest.kind === "approval" ? "approval" : "question";
        const payload: PushPayload = { text: rendered(language, `push.${kind}`, { agent, count: items.length }), count: items.length, itemId: newest.itemId };
        const keys = JSON.parse(this.secrets.open(newest.keys, subscriptionKeysAad(newest.endpoint))) as PushSubscription["keys"];
        await (this.options.send ?? pushVia(globalThis.fetch))({ endpoint: newest.endpoint, keys }, JSON.stringify(payload), {
          vapidDetails: { subject: this.options.subject, ...vapid },
          urgency: "high",
        });
        await this.db
          .insert(pushDeliveries)
          .values(items.map((i) => ({ questionId: i.itemId, subscriptionId: i.subscriptionId })))
          .onConflictDoNothing();
      } catch (err) {
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          outcome = "gone";
          await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, newest.subscriptionId));
        } else {
          outcome = "failed";
          logError("push.send failed", err, { ref: newest.subscriptionId });
        }
        recordError(span, outcome);
      } finally {
        span.setAttribute("dispand.result", outcome);
        counts.counter("dispand.push.sent").add(1, { "dispand.result": outcome });
        span.end();
      }
      return outcome;
    });
  }
}
