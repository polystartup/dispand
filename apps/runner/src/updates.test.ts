import { afterEach, expect, test, vi } from "vitest";
import { startUpdates } from "./updates.ts";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("./durable.ts", () => ({ writeDurable: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.read,
  mkdtemp: vi.fn(async () => "/tmp/dispand-update-test"),
  rm: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("manual launches never check for or install updates", () => {
  vi.stubEnv("DISPAND_RUNNER_MANAGED", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  startUpdates("https://dispand.test", "secret-token", "/config/dispand-runner");
  expect(fetch).not.toHaveBeenCalled();
});

test("a requested update runs the fixed installer in a separate user unit with the installed environment", async () => {
  vi.useFakeTimers();
  vi.stubEnv("DISPAND_RUNNER_MANAGED", "1");
  vi.stubEnv("CODEX_HOME", "/cli/codex");
  mocks.read.mockResolvedValue(JSON.stringify({ buildId: "a".repeat(64) }));
  mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(null, ""));
  const fetch = vi.fn().mockResolvedValue(Response.json({ update: false }))
    .mockResolvedValueOnce(Response.json({ update: true }))
    .mockResolvedValueOnce(new Response("#!/bin/sh\nexit 0"));
  vi.stubGlobal("fetch", fetch);
  startUpdates("https://dispand.test", "secret-token", "/config/dispand-runner");
  await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0]?.[0].href).toBe("https://dispand.test/runner/update");
  expect(fetch.mock.calls[1]?.[0].href).toBe("https://dispand.test/runner/install.sh");
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
  const [file, args] = mocks.exec.mock.calls[0]!;
  expect(file).toBe("systemd-run");
  expect(args).toEqual(expect.arrayContaining(["--user", "--collect", "--setenv=XDG_CONFIG_HOME=/config", "--setenv=CODEX_HOME=/cli/codex", "/bin/sh", "/tmp/dispand-update-test/install.sh"]));
  expect(JSON.stringify(args)).not.toContain("secret-token");
  mocks.read.mockResolvedValue(JSON.stringify({ buildId: "b".repeat(64) }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[2]?.[1].headers["dispand-runner-build"]).toBe("a".repeat(64));
});
