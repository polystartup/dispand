// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { SubmitButton } from "./AuthCard.tsx";

test("the submit button is enabled only once the form is hydrated: before, a submit would post the page and lose it", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<SubmitButton busy={false}>Sign in</SubmitButton>);
  expect(container.querySelector("button")!.disabled).toBe(true);
  await act(async () => {
    hydrateRoot(container, <SubmitButton busy={false}>Sign in</SubmitButton>);
  });
  expect(container.querySelector("button")!.disabled).toBe(false);
});
