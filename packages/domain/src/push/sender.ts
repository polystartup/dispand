import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { type PushSubscription, type RequestOptions, sendNotification, WebPushError } from "web-push";
import type { Db } from "../db/client.ts";
import { agents, pushDeliveries, pushSubscriptions, questions, runs, user, workflows } from "../db/schema.ts";
import type { Engine } from "../engine/engine.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";
import { errorKind, logError } from "../log.ts";
import { type Language, rendered } from "../messages/index.ts";
import type { SecretBox } from "../secrets.ts";
import { inSpan, meter, recordError, tracer } from "../telemetry/index.ts";
import { subscriptionKeysAad, vapidKeys } from "./keys.ts";

const traces = tracer("push");
const counts = meter("push");

/** Items asked within this window after the first go as one push, with their count. */
export const WINDOW_MS = 10_000;
/** A device that failed is tried again after this, while its items still wait. */
export const RETRY_MS = 60_000;

/**
 * What a push carries through the browser vendor's push service: a sentence naming the agent and
 * the item's kind, how many items it stands for, and the newest one's random id. Never a
 * question's text or a proposal's items.
 */
export type PushPayload = { text: string; count: number; itemId: string };

export type Send = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

type Options = {
  /** The VAPID subject: the app's https URL, or a `mailto:`. */
  subject: string;
  /** Tests: stands in for `web-push`. */
  send?: Send;
  windowMs?: number;
  retryMs?: number;
};

/** Every pending Inbox item with every subscription it hasn't reached and that was made before it was asked, newest first. */
function waitingItems(db: Db) {
  return db
    .select({
      itemId: questions.id,
      kind: questions.kind,
      agentName: jobAgentNameSql,
      builtIn: agents.builtIn,
      workflowName: workflows.name,
      subscriptionId: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      keys: pushSubscriptions.keys,
      language: pushSubscriptions.language,
      chosen: user.language,
    })
    .from(questions)
    .innerJoin(pushSubscriptions, and(eq(pushSubscriptions.ownerId, questions.ownerId), gt(questions.createdAt, pushSubscriptions.createdAt)))
    .innerJoin(user, eq(user.id, questions.ownerId))
    .innerJoin(runs, eq(runs.id, questions.runId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(workflows, eq(workflows.id, runs.workflowId))
    .leftJoin(pushDeliveries, and(eq(pushDeliveries.questionId, questions.id), eq(pushDeliveries.subscriptionId, pushSubscriptions.id)))
    .where(and(eq(questions.status, "pending"), ne(questions.kind, "consult"), isNull(pushDeliveries.questionId)))
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
  private running: Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();

  constructor(
    private readonly db: Db,
    private readonly engine: Pick<Engine, "questionChanges">,
    private readonly secrets: SecretBox,
    private readonly options: Options,
  ) {}

  start(): void {
    const changes = this.engine.questionChanges.subscribe("changed", { signal: this.stopping.signal });
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
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  /** Sends what waits now, one flush at a time. */
  flush(): Promise<void> {
    this.running = this.running.then(() => this.sendWaiting()).catch((err: unknown) => logError("push.flush failed", err));
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    clearTimeout(this.timer);
    await this.running;
  }

  private sendWaiting(): Promise<void> {
    return inSpan(traces, "push.flush", {}, errorKind, async (span) => {
      const waiting = await waitingItems(this.db);
      span.setAttribute("dispand.push.items", waiting.length);
      if (waiting.length === 0) return;
      const bySubscription = new Map<string, Waiting[]>();
      for (const row of waiting) bySubscription.set(row.subscriptionId, [...(bySubscription.get(row.subscriptionId) ?? []), row]);
      const vapid = await vapidKeys(this.db, this.secrets);
      const outcomes = await Promise.all([...bySubscription.values()].map((items) => this.sendOne(items, vapid)));
      if (outcomes.includes("failed")) this.wake(this.options.retryMs ?? RETRY_MS);
    });
  }

  /** One push to one subscription for its waiting items (newest first): sent, gone (404 or 410: deleted), or failed (tried again). */
  private sendOne(items: Waiting[], vapid: { publicKey: string; privateKey: string }): Promise<string> {
    const newest = items[0]!;
    return traces.startActiveSpan("push.send", { attributes: { "dispand.push.subscription": newest.subscriptionId, "dispand.push.count": items.length } }, async (span) => {
      let outcome = "sent";
      try {
        // The language the user chose in Settings, else the one that browser shows.
        const language = (newest.chosen ?? newest.language) as Language;
        const agent = newest.builtIn === "assistant" ? rendered(language, "agent.assistant.name") : (newest.agentName ?? newest.workflowName ?? "");
        const kind = newest.kind === "approval" ? "approval" : "question";
        const payload: PushPayload = { text: rendered(language, `push.${kind}`, { agent, count: items.length }), count: items.length, itemId: newest.itemId };
        const keys = JSON.parse(this.secrets.open(newest.keys, subscriptionKeysAad(newest.endpoint))) as PushSubscription["keys"];
        await (this.options.send ?? sendNotification)({ endpoint: newest.endpoint, keys }, JSON.stringify(payload), {
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
