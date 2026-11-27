import { expect, test, vi } from "vitest";
import { downloadRelease } from "../skillshare-release.ts";

test("a stalled release download is retried, and fails after its third stalled attempt", async () => {
  const archive = Buffer.from("release archive");
  let stalls = 1;
  // A stalled transfer never settles until its signal aborts it; a good one answers at once.
  const fetch = vi.fn((_url: string, init: RequestInit) =>
    stalls-- > 0
      ? new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
      : Promise.resolve(new Response(archive)),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    expect(await downloadRelease("https://example.com/release.tar.gz", 1)).toEqual(archive);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    stalls = Infinity;
    await expect(downloadRelease("https://example.com/release.tar.gz", 1)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
