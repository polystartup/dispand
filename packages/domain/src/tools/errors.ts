/**
 * A failed listing or call, with a short reason made here (host, status), never the server's own
 * text: an error body or message may echo the headers.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
