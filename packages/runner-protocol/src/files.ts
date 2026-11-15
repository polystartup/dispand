/**
 * Where a Job's CLI session hands Dispand the files its runner tools return, with the Job's
 * token (`POST`, JSON `{ files: [{ name, base64 }] }`): they become the Job's attachments, and
 * the reply's `text` takes their place in the result. Over HTTP, not the runner's WebSocket: a
 * file may be ten times a frame.
 */
export const JOB_FILES_PATH = "/mcp/job/files";
/** The largest file a tool result keeps. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The most files one tool result holds. */
export const MAX_RESULT_FILES = 20;
/** The largest body `JOB_FILES_PATH` takes: one result's files in base64, and room for its JSON. */
export const MAX_RESULT_BODY_BYTES = MAX_RESULT_FILES * Math.ceil(MAX_FILE_BYTES / 3) * 4 + 1024 * 1024;

/**
 * Why none of a result's files are kept, by the per-result limits alone (the runner checks
 * before sending, Dispand again before storing); null when they pass. Told to the agent, so
 * English.
 */
export function resultRefusal(files: { name: string; size: number }[]): string | null {
  if (files.length > MAX_RESULT_FILES) return `None of the ${files.length} files in this result were kept: a result keeps at most ${MAX_RESULT_FILES}.`;
  const big = files.findIndex((f) => f.size > MAX_FILE_BYTES);
  if (big >= 0) return `None of the files in this result were kept: file ${big + 1} (“${files[big]!.name}”) is larger than 10 MiB, the most a file may be.`;
  return null;
}
