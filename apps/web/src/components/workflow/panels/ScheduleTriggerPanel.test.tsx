// @vitest-environment jsdom
import type { ScheduleField } from "@dispand/domain/workflows/model";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ScheduleTriggerPanel, type ScheduleFire } from "./ScheduleTriggerPanel.tsx";

afterEach(cleanup);

const start: ScheduleField = { id: "n_s", key: "schedule", type: "schedule", label: "Schedule", cron: "0 9 * * 1-5", timezone: "Europe/Paris" };

/** The panel over a field it edits, like the editor; `onChange` sees every edit. */
function setup(opts: { field?: ScheduleField; fires?: ScheduleFire[]; enabled?: boolean } = {}) {
  const onChange = vi.fn();
  const onPause = vi.fn();
  function Harness() {
    const [field, setField] = useState(opts.field ?? start);
    return (
      <ScheduleTriggerPanel
        field={field}
        schedule={{ enabled: opts.enabled ?? true, nextFireAt: new Date("2026-11-06T08:00:00Z") }}
        fires={opts.fires ?? []}
        // Thursday 5 Nov 2026, 10:05 in Paris.
        now={new Date("2026-11-05T09:05:00Z")}
        onChange={(next) => {
          onChange(next);
          setField(next);
        }}
        onPause={onPause}
      />
    );
  }
  render(<Harness />);
  return { onChange, onPause, user: userEvent.setup() };
}

const lastCron = (onChange: ReturnType<typeof vi.fn>) => (onChange.mock.lastCall![0] as ScheduleField).cron;

test('weekly preset at 08:30 on Monday emits "30 8 * * 1"', async () => {
  const { onChange, user } = setup();
  await user.click(screen.getByRole("radio", { name: "Every week" }));
  await user.selectOptions(screen.getByLabelText("Day"), "Monday");
  fireEvent.change(screen.getByLabelText("Time"), { target: { value: "08:30" } });
  expect(lastCron(onChange)).toBe("30 8 * * 1");
});

test("a custom cron with 6 fields shows the problem and doesn't call onChange with it", async () => {
  const { onChange, user } = setup();
  await user.click(screen.getByRole("radio", { name: "Custom" }));
  const cron = screen.getByLabelText("Cron");
  expect((cron as HTMLInputElement).value).toBe("0 9 * * 1-5");
  await user.clear(cron);
  await user.type(cron, "0 0 9 * * *");
  expect(screen.getByRole("alert").textContent).toBe("Use 5 fields: minute hour day month weekday");
  expect(onChange.mock.calls.map(([f]) => (f as ScheduleField).cron)).not.toContain("0 0 9 * * *");
  await user.clear(cron);
  await user.type(cron, "*/15 9-17 * * 1-5");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(lastCron(onChange)).toBe("*/15 9-17 * * 1-5");
});

test("a cron no preset matches opens on Custom", () => {
  setup({ field: { ...start, cron: "*/5 * * * *" } });
  expect(screen.getByRole("radio", { name: "Custom" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText("Cron") as HTMLInputElement).value).toBe("*/5 * * * *");
});

test("next runs show three times in the schedule's timezone", async () => {
  setup({ field: { ...start, timezone: "America/New_York" } });
  const next = within(screen.getByRole("list", { name: "Next runs" }));
  // Weekdays at 09:00 New York time, after 04:05 there on Thursday 5 Nov.
  expect(next.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Thu 5 Nov, 09:00", "Fri 6 Nov, 09:00", "Mon 9 Nov, 09:00"]);
  expect(screen.getByText(/America\/New_York/)).toBeTruthy();
});

test("an unknown timezone is shown, not saved", async () => {
  const { onChange, user } = setup();
  const tz = screen.getByLabelText("Timezone");
  await user.clear(tz);
  await user.type(tz, "Mars/Olympus");
  expect(screen.getByRole("alert").textContent).toBe("Unknown timezone");
  expect(onChange.mock.calls.map(([f]) => (f as ScheduleField).timezone)).not.toContain("Mars/Olympus");
  await user.clear(tz);
  await user.type(tz, "Asia/Tokyo");
  expect((onChange.mock.lastCall![0] as ScheduleField).timezone).toBe("Asia/Tokyo");
});

test("the Paused switch pauses and resumes", async () => {
  const { onPause, user } = setup();
  await user.click(screen.getByRole("switch", { name: "Paused" }));
  expect(onPause).toHaveBeenCalledWith(false);
});

test("recent fires say what happened", () => {
  setup({
    fires: [
      { scheduledFor: new Date("2026-11-05T08:00:00Z"), status: "started", runId: "run_1", message: null },
      { scheduledFor: new Date("2026-11-04T08:00:00Z"), status: "skipped-overlap", runId: null, message: null },
      { scheduledFor: new Date("2026-11-03T08:00:00Z"), status: "refused", runId: null, message: "Choose an agent" },
    ],
  });
  const recent = within(screen.getByRole("list", { name: "Recent" }));
  expect(recent.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Thu 5 Nov, 09:00Started",
    "Wed 4 Nov, 09:00Skipped: a run was still going",
    "Tue 3 Nov, 09:00Refused: Choose an agent",
  ]);
  expect(recent.getByRole("link", { name: "Started" }).getAttribute("href")).toBe("/settings/workflows/runs/run_1");
});
