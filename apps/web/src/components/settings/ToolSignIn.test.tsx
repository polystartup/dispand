// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ToolSignIn } from "./ToolSignIn.tsx";

afterEach(cleanup);

test("ToolSignIn says where the sign-in stands and offers Connect or Re-authorize", () => {
  const { rerender } = render(<ToolSignIn status="authorize" clientId={null} onConnect={() => {}} />);
  expect(screen.getByRole("status").textContent).toMatch(/Not connected yet/);
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  rerender(<ToolSignIn status="connected" clientId={null} onConnect={() => {}} />);
  expect(screen.getByRole("status").textContent).toBe("Connected.");
  expect(screen.getByRole("button", { name: "Re-authorize" })).toBeTruthy();
  rerender(<ToolSignIn status="reauthorize" clientId={null} onConnect={() => {}} />);
  expect(screen.getByRole("status").textContent).toMatch(/stopped working/);
  expect(screen.getByRole("button", { name: "Re-authorize" })).toBeTruthy();
});

test("ToolSignIn connects without a client unless one is entered", async () => {
  const connect = vi.fn();
  render(<ToolSignIn status="authorize" clientId={null} onConnect={connect} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(connect).toHaveBeenLastCalledWith();
  await user.click(screen.getByRole("button", { name: "Enter a client id" }));
  await user.type(screen.getByLabelText("Client id"), "given-id");
  await user.type(screen.getByLabelText("Client secret"), "given-secret");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(connect).toHaveBeenLastCalledWith({ clientId: "given-id", clientSecret: "given-secret" });
});

test("ToolSignIn keeps a stored client unless it is changed or cleared, and never shows its secret", async () => {
  const connect = vi.fn();
  render(<ToolSignIn status="connected" clientId="given-id" onConnect={connect} />);
  expect((screen.getByLabelText("Client id") as HTMLInputElement).value).toBe("given-id");
  expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Re-authorize" }));
  expect(connect).toHaveBeenLastCalledWith();
  await user.clear(screen.getByLabelText("Client id"));
  await user.click(screen.getByRole("button", { name: "Re-authorize" }));
  expect(connect).toHaveBeenLastCalledWith(null);
});
