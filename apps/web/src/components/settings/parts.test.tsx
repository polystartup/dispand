// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "./parts.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The texts that describe a control, in order; null with no description at all. */
function description(control: Element): string[] | null {
  const ids = control.getAttribute("aria-describedby");
  return ids === null ? null : ids.split(" ").map((id) => document.getElementById(id)?.textContent ?? `no element ${id}`);
}

/** The ways the app writes a field's control. */
const shapes = {
  "an input": <Input id="f" />,
  "a textarea": <Textarea id="f" />,
  "a native select": (
    <select id="f">
      <option>One</option>
    </select>
  ),
  "a select's trigger": (
    <Select>
      <SelectTrigger id="f">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">One</SelectItem>
      </SelectContent>
    </Select>
  ),
  "a control in a wrapper, beside others": (
    <div>
      <Input id="f" />
      <button type="button">Copy</button>
    </div>
  ),
};

test.each(Object.entries(shapes))("%s is described by the hint and the error, and invalid with an error", (_, control) => {
  const problems = vi.spyOn(console, "error");
  const field = (hint?: string, error?: string) => (
    <FormField label="Name" htmlFor="f" hint={hint} error={error}>
      {control}
    </FormField>
  );
  const { rerender } = render(field());
  const found = () => document.getElementById("f")!;
  const first = found();
  expect([description(first), first.getAttribute("aria-invalid")]).toEqual([null, null]);

  rerender(field("A hint"));
  expect([description(found()), found().getAttribute("aria-invalid")]).toEqual([["A hint"], null]);

  rerender(field(undefined, "Wrong"));
  expect([description(found()), found().getAttribute("aria-invalid")]).toEqual([["Wrong"], "true"]);
  expect(screen.getByRole("alert").textContent).toBe("Wrong");

  rerender(field("A hint", "Wrong"));
  expect([description(found()), found().getAttribute("aria-invalid")]).toEqual([["Wrong", "A hint"], "true"]);

  rerender(field());
  expect([description(found()), found().getAttribute("aria-invalid")]).toEqual([null, null]);
  // The same element throughout: a control that remounted would lose the focus.
  expect(found()).toBe(first);
  expect(problems).not.toHaveBeenCalled();
});

test("typing keeps the focus while an error comes and goes, among several children", async () => {
  const problems = vi.spyOn(console, "error");
  function Field() {
    const [value, setValue] = useState("");
    return (
      <FormField label="Name" htmlFor="f" error={value === "a" ? "Too short" : undefined}>
        <Input id="f" value={value} onChange={(e) => setValue(e.target.value)} />
        <datalist id="names">
          <option value="Ada" />
        </datalist>
      </FormField>
    );
  }
  render(<Field />);
  const input = screen.getByLabelText("Name");
  await userEvent.type(input, "ab");
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("ab");
  expect(problems).not.toHaveBeenCalled();
});

test("a control's own description is kept, before the field's", () => {
  render(
    <>
      <p id="own">Own</p>
      <FormField label="Name" htmlFor="f" hint="A hint">
        <Input id="f" aria-describedby="own" aria-invalid />
      </FormField>
    </>,
  );
  const input = screen.getByLabelText("Name");
  expect([description(input), input.getAttribute("aria-invalid")]).toEqual([["Own", "A hint"], "true"]);
});
