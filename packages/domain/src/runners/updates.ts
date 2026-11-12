import { emitLog } from "../telemetry/index.ts";

type State = { buildId: string; seen: number; started?: number; delivered?: boolean; failed: boolean };

/** Update control v1, independent of the session protocol so incompatible runners can update. */
export class RunnerUpdates {
  buildId: string | undefined;
  private readonly states = new Map<string, State>();

  poll(runnerId: string, buildId: string, failed: boolean): boolean {
    const previous = this.states.get(runnerId);
    const state: State = { ...previous, buildId, seen: Date.now(), failed };
    if (buildId === this.buildId) {
      delete state.started;
      delete state.delivered;
    }
    this.states.set(runnerId, state);
    if (!state.started || state.delivered || Date.now() - state.started >= 180_000) return false;
    state.failed = false;
    state.delivered = true;
    return true;
  }

  status(runnerId: string): "unavailable" | "current" | "available" | "updating" | "failed" {
    const s = this.states.get(runnerId);
    if (!this.buildId || !s) return "unavailable";
    if (s.started && Date.now() - s.started < 180_000 && !s.failed) return "updating";
    if (Date.now() - s.seen > 30_000) return s.started ? "failed" : "unavailable";
    if (s.buildId === this.buildId) return "current";
    return s.failed || s.started ? "failed" : "available";
  }

  request(runnerId: string): boolean {
    const status = this.status(runnerId);
    if (status !== "available" && status !== "failed") return false;
    const s = this.states.get(runnerId)!;
    if (Date.now() - s.seen > 30_000) return false;
    s.started = Date.now();
    s.delivered = false;
    s.failed = false;
    emitLog("runners", "info", "runner update requested", { "dispand.runner.id": runnerId });
    return true;
  }
}
