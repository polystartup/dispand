import { vi } from "vitest";

// `vi.waitFor` gives up after 1 s unless a call says otherwise: too short when test files share a
// busy CPU (CI). A wait ends as soon as its condition holds, so the ceiling only matters for a test
// that fails. Vitest has no setting for it, so this setup file wraps it, once: a setup file runs
// again before each test file, on the worker's one `vi`.
const TIMEOUT = 5_000;
if (!(vi.waitFor as { wrapped?: true }).wrapped) {
  const waitFor = vi.waitFor;
  vi.waitFor = Object.assign(
    ((callback, options) => waitFor(callback, typeof options === "number" ? options : { ...options, timeout: options?.timeout ?? TIMEOUT })) as typeof vi.waitFor,
    { wrapped: true as const },
  );
}
