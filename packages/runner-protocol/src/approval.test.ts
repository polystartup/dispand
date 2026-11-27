import { expect, test } from "vitest";
import { approvalRequest, MAX_APPROVAL_MESSAGE, REQUEST_APPROVAL_INPUT_SCHEMA } from "./approval.ts";

test("the arguments' schema is the one every harness sent before it was made here once, byte for byte", () => {
  expect(JSON.stringify(REQUEST_APPROVAL_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{"message":{"type":"string","description":"What you ask to be approved, as one clear question"},"proposal":{"type":"string","description":"The id propose gave you, when you ask for a proposal: the owner then approves its listed writes"}},"required":["message"],"additionalProperties":false}',
  );
});

test.each([
  ["words, trimmed", { message: " May I? " }, { message: "May I?" }],
  ["words and a proposal", { message: "May I?", proposal: "prop_01ABC" }, { message: "May I?", proposal: "prop_01ABC" }],
  ["the longest words", { message: "x".repeat(MAX_APPROVAL_MESSAGE) }, { message: "x".repeat(MAX_APPROVAL_MESSAGE) }],
  ["no words", { message: "   " }, { error: "request_approval needs a message: what you ask to be approved." }],
  ["words that aren't text", { message: 123 }, { error: "request_approval needs a message: what you ask to be approved." }],
  ["no arguments", null, { error: "request_approval needs a message: what you ask to be approved." }],
  [
    "too many words",
    { message: "x".repeat(MAX_APPROVAL_MESSAGE + 1) },
    { error: "The message is too long to show whole (at most 4000 characters): shorten it." },
  ],
  [
    "a proposal that isn't an id",
    { message: "May I?", proposal: "a b" },
    { error: "proposal must be the id propose gave you; leave it out to ask in words only." },
  ],
  ["a proposal that isn't text", { message: "May I?", proposal: 1 }, { error: "proposal must be the id propose gave you; leave it out to ask in words only." }],
])("%s", (_name, args, expected) => {
  expect(approvalRequest(args)).toEqual(expected);
});
