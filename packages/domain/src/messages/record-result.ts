import type { HarnessEvent } from "@dispand/runner-protocol";
import type { Cell, FieldType } from "../data/fields.ts";

/** Authorized values and their display labels, captured when rows_get succeeds. */
export type RecordResult = {
  kind: "record";
  tableId: string;
  rowId: string;
  fields: { id: string; name: string; type: FieldType; value: Cell }[];
};

export type RecordToolResult = {
  toolCallId: string;
  turnId: string;
  args: { id: string };
  record: RecordResult;
};

/**
 * A generated artifact shown in the chat (`artifact_show`): a reference only, never its code,
 * which `artifacts.get` returns to its owner. Only that tool writes one.
 */
export type ArtifactRef = { kind: "artifact"; artifactId: string; title: string; format: "html" | "svg"; size: number };

/** What a tool message may show: a record card or an artifact. */
export type ToolMessageResult = RecordToolResult | ArtifactRef;

/** In-process cloud events only; never part of the runner's wire protocol. */
export type CloudRecordEvent =
  | { type: "record-start"; toolCallId: string; turnId: string; args: { id: string } }
  | ({ type: "record-result" } & RecordToolResult);
export type CloudEvent = HarnessEvent | CloudRecordEvent;
