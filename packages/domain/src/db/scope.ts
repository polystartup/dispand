import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./client.ts";

/** Whose data a unit of database work may touch. Set only at entry points, from trusted rows. */
export type Scope = Readonly<{ userId?: string; organizationId?: string; workspaceId?: string }>;
/** Narrow cross-workspace reads: ids, workspace ids, hashes, scheduling columns. Never content or writes. */
export const SYSTEM: unique symbol = Symbol.for("dispand.scope.system") as never;
export type Ambient = Scope | typeof SYSTEM;

/** Why an install refuses an organization: a message key it registered (`registerMessages`), and where to go about it. */
export type OrganizationRefusal = { key: string; link: string };

/**
 * How work that spans workspaces is split, and whether an organization may be used now. Chosen at
 * `openDb`; feature code never branches on how work is split.
 */
export interface Tenancy {
  /** Runs `work` once per scope `scopes` lists, or once as is. */
  each(db: Db, scopes: (db: Db) => Promise<Scope[]>, work: () => Promise<void>): Promise<void>;
  /** Runs `work` in the scope of the run, or as is. Only for run ids taken from engine or database state. */
  forRun<T>(db: Db, runId: string, work: () => Promise<T>): Promise<T>;
  /**
   * The install's refusal of an organization now, or undefined to let it be used. Synchronous: it
   * answers from what the install keeps in memory, ready before `startApp`, and never throws, so
   * it can be asked on every call, inside transactions included. `link` is an absolute `https:`
   * URL or a same-origin path. None (the default): no organization is ever refused.
   */
  refusal?(organizationId: string): OrganizationRefusal | undefined;
}

/** One installation, one tenant: work runs once, as is. The default. */
export const shared: Tenancy = { each: (_db, _scopes, work) => work(), forRun: (_db, _runId, work) => work() };

// On globalThis: the web server bundle inlines this package, and a database adapter loaded beside it must share the same store.
const g = globalThis as { __dispandScope?: AsyncLocalStorage<Ambient>; __dispandTenancy?: WeakMap<Db, Tenancy> };
const ambient = (g.__dispandScope ??= new AsyncLocalStorage<Ambient>());
const tenancies = (g.__dispandTenancy ??= new WeakMap<Db, Tenancy>());

/** The ambient scope, what a database adapter reads; undefined means none and denies. */
export function currentScope(): Ambient | undefined {
  return ambient.getStore();
}

/** Runs `work` with `scope` ambient, replacing any outer one. Awaits inside: Drizzle builders run where they are awaited. */
export function inScope<T>(scope: Ambient, work: () => PromiseLike<T> | T): Promise<T> {
  return ambient.run(scope, async () => await work());
}

/** Wraps a long-lived callback (timer, listener) so each call runs with no scope, whoever fires it. */
export function detached<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  return (...args) => {
    ambient.exit(() => fn(...args));
  };
}

export function setTenancy(db: Db, tenancy: Tenancy): void {
  tenancies.set(db, tenancy);
}

/** The tenancy the database was opened with (`shared` when none was given). */
export function tenancyOf(db: Db): Tenancy {
  return tenancies.get(db) ?? shared;
}

/** Runs `work` per scope the database's tenancy splits it into. */
export function eachScope(db: Db, scopes: (db: Db) => Promise<Scope[]>, work: () => Promise<void>): Promise<void> {
  return (tenancies.get(db) ?? shared).each(db, scopes, work);
}

/** Whether the database's tenancy may refuse an organization: without, nothing needs looking up for it. */
export function refuses(db: Db): boolean {
  return !!tenancies.get(db)?.refusal;
}

/**
 * The install's refusal of the organization now (`Tenancy.refusal`), or undefined. Ask it only once
 * the caller is admitted there, with the database as opened, never a transaction's handle: the
 * tenancy is kept per database.
 */
export function refusalOf(db: Db, organizationId: string): OrganizationRefusal | undefined {
  return tenancies.get(db)?.refusal?.(organizationId);
}

/** Runs stored work of a run in the scope the database's tenancy gives it. */
export function inRunScope<T>(db: Db, runId: string, work: () => Promise<T>): Promise<T> {
  return (tenancies.get(db) ?? shared).forRun(db, runId, work);
}
