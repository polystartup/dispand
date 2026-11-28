// @vitest-environment jsdom
import { stored } from "@dispand/domain/messages/index.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/i18n.ts";
import "../../test/jsdom-shims.ts";
import { StoppedWork } from "./StoppedWork.tsx";

afterEach(cleanup);

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s));
const step = (id: string, status: string, error: string | null, started: number, finished: number) => ({
  id,
  nodeId: id,
  status,
  error,
  startedAt: at(started),
  finishedAt: at(finished),
});
const message = (id: string, role: string, text: string, s: number, result?: unknown) => ({ id, role, text, createdAt: at(s), result });
const snapshot = (over: { run?: object; steps?: unknown[]; messages?: unknown[]; questions?: unknown[] }) =>
  ({
    run: { id: "run_1", source: "agent", status: "failed", error: null, finishedAt: at(9), ...over.run },
    steps: over.steps ?? [],
    messages: over.messages ?? [],
    questions: over.questions ?? [],
  }) as unknown as RunSnapshot;

const part = (name: RegExp | string) => within(screen.getByRole("region", { name }));

test("a stopped run shows, in place, what it completed, what it recorded, the ids to find it by and what to do next", async () => {
  const lost = stored("engine.chatRunnerGone");
  render(
    <StoppedWork
      def={undefined}
      run={snapshot({
        run: { error: lost },
        steps: [step("s_other", "succeeded", null, 7, 8), step("s_chat", "failed", lost, 1, 9)],
        messages: [
          message("m3", "tool", "artifact_show", 4),
          message("m1", "user", "Chart my week", 2),
          message("m2", "assistant", "On it.", 3),
          message("m4", "tool", "artifact_show", 5, { kind: "artifact", artifactId: "art_1", title: "Weekly tasks" }),
        ],
        questions: [{ id: "q1", createdAt: at(6), status: "expired", payload: { kind: "choice" } }],
      })}
    />,
  );
  const opener = screen.getByRole("button", { name: "Inspect what happened" });
  expect(screen.queryByRole("region", { name: "Identifiers" })).toBeNull();
  const user = userEvent.setup();
  await user.click(opener);
  expect(opener.getAttribute("aria-expanded")).toBe("true");
  expect(part(/^Stopped on /).getAllByText(/./, { selector: "p" })).toHaveLength(1);
  // A reply and a tool call are activity, not known to be complete: only the finished step and the artifact are.
  expect(
    part("Completed work")
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["Step finished", "Artifact shown: Weekly tasks"]);
  // Oldest first, each with its time.
  const events = part("Recorded activity").getAllByRole("listitem");
  expect(events.map((li) => li.querySelector("span")!.textContent)).toEqual([
    "Step started",
    "Message sent",
    "The agent replied",
    "Tool called: artifact_show",
    "Artifact shown: Weekly tasks",
    "Question asked, with no answer",
    "Step started",
    "Step finished",
    "Step stopped",
  ]);
  expect(events.map((li) => li.querySelector("time")!.dateTime)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => at(s).toISOString()));
  const ids = part("Identifiers");
  expect(ids.getByText("Job ID")).toBeTruthy();
  for (const id of ["run_1", "s_chat", "engine.chatRunnerGone"]) expect(ids.getByText(id)).toBeTruthy();
  expect(part("Next step").getByText(/^Nothing runs again by itself, and this conversation takes no more messages\./)).toBeTruthy();
  // No recovery action, and no word that the work goes on.
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Inspect what happened", "Close"]);
  expect(document.body.textContent).not.toMatch(/resume|retry|try again/i);
  const reveal = vi.spyOn(opener, "scrollIntoView");
  await user.keyboard("{Escape}");
  expect(opener.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(opener);
  expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
});

test("a conversation the person can go on with says so; words from outside have no error code, and nothing completed is said", async () => {
  render(
    <StoppedWork
      def={undefined}
      run={snapshot({
        run: { source: "workflow", continuationNodeId: "s_chat", error: "claude is not signed in" },
        steps: [step("s_chat", "failed", "claude is not signed in", 1, 2)],
      })}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Inspect what happened" }));
  expect(part(/^Stopped on /).getByText("claude is not signed in")).toBeTruthy();
  expect(part("Completed work").getByText("No finished step or artifact was recorded.")).toBeTruthy();
  expect(part("Identifiers").getByText("Run ID")).toBeTruthy();
  expect(part("Identifiers").queryByText("Error code")).toBeNull();
  expect(part("Next step").getByText(/send a message here/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Next step" })).toBeNull();
});
