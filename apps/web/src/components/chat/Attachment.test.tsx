// @vitest-environment jsdom
import { type AppendMessage, type ThreadMessageLike, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { heldAttachments } from "../../lib/assistant-runtime.ts";
import { createI18n } from "../../lib/i18n.ts";
import { ComposerAttachment, MessageAttachment } from "./Attachment.tsx";
import "../../test/jsdom-shims.ts";

afterEach(cleanup);

function mount(hold: (file: File) => Promise<{ id: string; image: boolean }>, onNew: (message: AppendMessage) => Promise<void> = async () => {}) {
  const adapter = heldAttachments(hold);
  function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({ convertMessage: (message) => message, messages: [], onNew, adapters: { attachments: adapter } });
    return <AssistantRuntimeProvider runtime={runtime}>
      <button onClick={() => void runtime.thread.composer.addAttachment(new File(["bytes"], "photo.svg", { type: "image/svg+xml" })).catch(() => {})}>Attach</button>
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} /><ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
    </AssistantRuntimeProvider>;
  }
  render(<I18nextProvider i18n={createI18n("en")}><Harness /></I18nextProvider>);
  return userEvent.setup();
}

test("a validated image opens the preview dialog and remains removable", async () => {
  const user = mount(async () => ({ id: "att_image", image: true }));
  await user.click(screen.getByRole("button", { name: "Attach" }));
  const image = await screen.findByRole("img", { name: "photo.svg" });
  expect(image.getAttribute("src")).toBe("/files/att_image");
  await user.click(image);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Remove this file" }));
  expect(screen.queryByRole("img")).toBeNull();
});

test("failed upload stays visible and removable without a browser-MIME preview", async () => {
  let reject!: (reason: Error) => void;
  const user = mount(() => new Promise((_, fail) => { reject = fail; }));
  await user.click(screen.getByRole("button", { name: "Attach" }));
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  reject(new Error("private server detail"));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByText("private server detail")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Remove this file" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("sending an uploaded file carries its server id through the stock runtime", async () => {
  const onNew = vi.fn<(message: AppendMessage) => Promise<void>>(async () => {});
  const user = mount(async () => ({ id: "att_sent", image: false }), onNew);
  await user.click(screen.getByRole("button", { name: "Attach" }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onNew).toHaveBeenCalledOnce());
  expect(onNew.mock.calls[0]![0].attachments![0]!.id).toBe("att_sent");
});

test("sent files use the authorized download route, never a filename URL", async () => {
  const Message = () => <MessagePrimitive.Attachments components={{ Attachment: MessageAttachment }} />;
  function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({ convertMessage: (message) => message, messages: [{ role: "user" as const, content: "", attachments: [{ id: "att_sent", type: "file", name: "https://outside.example/photo.png", status: { type: "complete" as const }, content: [] }] }], onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{ Message }} /></AssistantRuntimeProvider>;
  }
  render(<I18nextProvider i18n={createI18n("en")}><Harness /></I18nextProvider>);
  expect((await screen.findByRole("link")).getAttribute("href")).toBe("/files/att_sent");
  expect(screen.getByRole("link").hasAttribute("download")).toBe(true);
  expect(screen.queryByRole("img")).toBeNull();
});

test("removing a pending upload does not resurrect it when the server finishes", async () => {
  let finish!: (value: { id: string; image: boolean }) => void;
  const user = mount(() => new Promise((resolve) => { finish = resolve; }));
  await user.click(screen.getByRole("button", { name: "Attach" }));
  expect(await screen.findByRole("status")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove this file" }));
  finish({ id: "att_removed", image: true });
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove this file" })).toBeNull();
});
