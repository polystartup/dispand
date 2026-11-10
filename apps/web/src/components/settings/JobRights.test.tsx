// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { JobRights, type Rights } from "./JobRights.tsx";

afterEach(cleanup);

const tables = [
  { id: "t1", name: "Clients" },
  { id: "t2", name: "Matters" },
];

function mount(initial: Rights) {
  const seen = vi.fn();
  function Harness() {
    const [rights, setRights] = useState(initial);
    return (
      <JobRights
        rights={rights}
        tables={tables}
        onChange={(next) => {
          seen(next);
          setRights(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { user: userEvent.setup(), seen };
}

test("JobRights shows an agent's bundles as they are, with all tables by default", () => {
  mount({ bundles: [], dataTables: "all" });
  expect((screen.getByRole("checkbox", { name: /Work on data/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox", { name: /Change tables and fields/ }) as HTMLInputElement).checked).toBe(false);
  // Which tables only matters once the agent works on data.
  expect(screen.queryByRole("radio", { name: "All tables" })).toBeNull();
});

test("JobRights gives the bundles and the chosen tables", async () => {
  const { user, seen } = mount({ bundles: [], dataTables: "all" });
  await user.click(screen.getByRole("checkbox", { name: /Work on data/ }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data"], dataTables: "all" });
  expect((screen.getByRole("radio", { name: "All tables" }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole("radio", { name: "Only these tables" }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data"], dataTables: [] });
  await user.click(screen.getByRole("checkbox", { name: "Matters" }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data"], dataTables: ["t2"] });
  await user.click(screen.getByRole("checkbox", { name: /Change tables and fields/ }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data", "configure"], dataTables: ["t2"] });
  await user.click(screen.getByRole("checkbox", { name: "Matters" }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data", "configure"], dataTables: [] });
  await user.click(screen.getByRole("radio", { name: "All tables" }));
  expect(seen).toHaveBeenLastCalledWith({ bundles: ["data", "configure"], dataTables: "all" });
});

test("JobRights keeps a table that no longer exists visible, so it can be unticked", () => {
  mount({ bundles: ["data"], dataTables: ["t1", "t_gone"] });
  expect((screen.getByRole("checkbox", { name: "Clients" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "A deleted table" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Matters" }) as HTMLInputElement).checked).toBe(false);
});
