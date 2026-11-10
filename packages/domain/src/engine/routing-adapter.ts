import type { Answer } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { stepRuns } from "../db/schema.ts";
import { CLOUD_SOURCE, type CliHarness, type CloudHarness, type Harness, type HarnessAdapter, isCloud, type StartParams } from "./harness.ts";

/** Hands each session to its harness's adapter: cloud sessions to the in-process runner, CLI ones to the hub. */
export class RoutingAdapter implements HarnessAdapter {
  constructor(
    private readonly db: Db,
    private readonly cli: HarnessAdapter<CliHarness>,
    private readonly cloud: HarnessAdapter<CloudHarness>,
  ) {}

  start(harness: Harness, start: StartParams): Promise<boolean> {
    return isCloud(harness) ? this.cloud.start(harness, start) : this.cli.start(harness, start);
  }

  async send(sessionId: string, text: string): Promise<boolean> {
    return (await this.adapterOf(sessionId)).send(sessionId, text);
  }

  async answer(sessionId: string, questionId: string, answer: Answer): Promise<boolean> {
    return (await this.adapterOf(sessionId)).answer(sessionId, questionId, answer);
  }

  private async adapterOf(sessionId: string): Promise<Pick<HarnessAdapter, "send" | "answer">> {
    const [row] = await this.db.select({ runnerId: stepRuns.runnerId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    return row?.runnerId === CLOUD_SOURCE ? this.cloud : this.cli;
  }
}
