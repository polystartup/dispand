// @vitest-environment jsdom
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import "../../test/jsdom-shims.ts";
import { AgentText, isAppPath } from "./AgentText.tsx";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const same = (m: ThreadMessageLike) => m;
const Message = () => (
  <MessagePrimitive.Root>
    <MessagePrimitive.Parts components={{ Text: AgentText }} />
  </MessagePrimitive.Root>
);
function Chat({ text }: { text: string }) {
  const runtime = useExternalStoreRuntime({ messages: [{ id: "a1", role: "assistant", content: [{ type: "text", text }] }] as ThreadMessageLike[], convertMessage: same, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ UserMessage: Message, AssistantMessage: Message }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

test("an agent's text is formatted: emphasis, headings, lists, code", async () => {
  const { container } = render(<Chat text={["# Plan", "Some **bold** and `code`.", "- one\n- two", "```\nconst a = 1;\n```"].join("\n\n")} />);
  expect(await screen.findByText("bold")).toBeTruthy();
  expect(container.querySelector("h1")?.textContent).toBe("Plan");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["one", "two"]);
  expect(container.querySelector("pre")?.textContent).toContain("const a = 1;");
});

test("it loads nothing from elsewhere: only the app's own files as images, and no raw HTML", async () => {
  const text = [
    "Start.",
    "![chart](/files/att_ok1)",
    "![tracker](https://evil.example/pixel.png)",
    "![relative](//evil.example/p.png)",
    "![traversal](/files/../api/x)",
    "![data](data:image/png;base64,AAAA)",
    '<img src="https://evil.example/raw.png">',
    '<script>fetch("https://evil.example/s")</script>',
    '<iframe src="https://evil.example/f"></iframe>',
  ].join("\n\n");
  const { container } = render(<Chat text={text} />);
  expect(await screen.findByText("Start.")).toBeTruthy();
  expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/files/att_ok1"]);
  // What was refused is said, with its description, never fetched.
  expect(screen.getByText("[image not shown: tracker]")).toBeTruthy();
  expect(container.querySelectorAll("script, iframe, object, embed, link, style").length).toBe(0);
  expect([...container.querySelectorAll("[src], [href], [srcset], [style]")].map((e) => e.outerHTML).join(" ")).not.toContain("evil.example");
});

test("a link shows where it goes and opens only on a click; one that goes nowhere a browser should is plain text", async () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const { container } = render(<Chat text={"See [the docs](https://example.org/docs), [this](javascript:alert(1)), [that](data:text/html,x) and <https://auto.example/x>."} />);
  expect(await screen.findByText("the docs")).toBeTruthy();
  // No anchor on the page: nothing to follow, prefetch or middle-click by accident.
  expect(container.querySelectorAll("a").length).toBe(0);
  expect(screen.getByText("(https://example.org/docs)")).toBeTruthy();
  expect(screen.queryByText(/javascript:/)).toBeNull();
  expect(open).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: /the docs/ }));
  expect(open).toHaveBeenCalledWith("https://example.org/docs", "_blank", "noopener,noreferrer");
  expect(screen.getAllByRole("button")).toHaveLength(2);
});

test("a link to a page of the app opens in the app; anything shaped otherwise stays as before", async () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  navigate.mockClear();
  render(<Chat text={"Sign in on [Firecrawl's page](/settings/tools?tool=tool_1), not [elsewhere](//evil.example/x) or [up](/settings/../../x)."} />);
  expect(await screen.findByText("Firecrawl's page")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "Firecrawl's page" }));
  expect(navigate).toHaveBeenCalledWith({ href: "/settings/tools?tool=tool_1" });
  expect(open).not.toHaveBeenCalled();
  // Neither is a link at all.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  for (const url of ["/settings/tools", "/assistant?run=r_1#end"]) expect(isAppPath(url)).toBe(true);
  for (const url of ["//host/x", "/a/../b", "/./a", "/a/%2e%2e/b", "/a%2fb", "/a\\b", "https://x.example/", "settings", ""]) expect(isAppPath(url), url).toBe(false);
});

test("a code block names its language and copies only its code, with retry on failure", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard refused")).mockResolvedValue(undefined);
  render(<Chat text={"Example:\n\n```ts\nconst answer = 42;\n```"} />);
  expect(await screen.findByText("ts")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy code" }));
  expect(await screen.findByText("Copy failed; try again")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy code" }));
  expect(copy).toHaveBeenLastCalledWith("const answer = 42;\n");
  expect(await screen.findByText("Copied")).toBeTruthy();
});
