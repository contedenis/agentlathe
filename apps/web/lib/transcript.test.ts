import { describe, expect, it } from "vitest";
import { toTranscriptMessages } from "./transcript";

describe("toTranscriptMessages — one review shape for three transports", () => {
  it("non-array input yields no messages", () => {
    expect(toTranscriptMessages(null, "in")).toEqual([]);
    expect(toTranscriptMessages({ role: "user" }, "in")).toEqual([]);
  });

  it("string content becomes a text part; empty content drops the message", () => {
    const messages = toTranscriptMessages(
      [
        { role: "user", content: "hola" },
        { role: "assistant", content: "" },
      ],
      "in",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hola" }],
    });
  });

  it("keeps provided ids and synthesizes positional ids otherwise", () => {
    const messages = toTranscriptMessages(
      [
        { id: "msg-1", role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      "out",
    );

    expect(messages.map((message) => message.id)).toEqual(["msg-1", "out-1"]);
  });

  it("passes through dashboard UI messages that already carry parts", () => {
    const parts = [{ type: "text", text: "ya armado" }];
    const [message] = toTranscriptMessages(
      [{ id: "u1", role: "user", parts }],
      "in",
    );

    expect(message.parts).toBe(parts);
  });

  it("pairs a tool call with its result from the separate tool message", () => {
    const [message] = toTranscriptMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "looking..." },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "search",
              input: { q: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", output: { hits: 3 } },
          ],
        },
      ],
      "in",
    );

    expect(message.parts).toEqual([
      { type: "text", text: "looking..." },
      {
        type: "tool-search",
        toolCallId: "c1",
        input: { q: 1 },
        state: "output-available",
        output: { hits: 3 },
      },
    ]);
  });

  it("a tool call with no result renders as input-available", () => {
    const [message] = toTranscriptMessages(
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c9", toolName: "slow" }],
        },
      ],
      "in",
    );

    expect(message.parts[0]).toMatchObject({
      type: "tool-slow",
      state: "input-available",
    });
  });

  it("tool role messages never surface as their own entries", () => {
    const messages = toTranscriptMessages(
      [
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", output: "x" }],
        },
      ],
      "in",
    );

    expect(messages).toEqual([]);
  });
});
