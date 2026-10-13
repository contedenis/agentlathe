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

    expect(message.parts).toEqual(parts);
  });

  it("drops parts that are not objects, so a corrupt row cannot crash the run page", () => {
    const [message] = toTranscriptMessages(
      [
        {
          id: "u1",
          role: "user",
          parts: [null, "x", { type: "text", text: "ok" }],
        },
      ],
      "in",
    );

    expect(message.parts).toEqual([{ type: "text", text: "ok" }]);
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

  it("unwraps ModelMessage tool results into the matching UI states", () => {
    const [message] = toTranscriptMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "ok", toolName: "a", input: {} },
            { type: "tool-call", toolCallId: "no", toolName: "b", input: {} },
            { type: "tool-call", toolCallId: "err", toolName: "c", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "ok",
              output: { type: "json", value: { hits: 3 } },
            },
            {
              type: "tool-result",
              toolCallId: "no",
              output: { type: "execution-denied", reason: "needs approval" },
            },
            {
              type: "tool-result",
              toolCallId: "err",
              output: { type: "error-text", value: "HTTP 500" },
            },
          ],
        },
      ],
      "out",
    );

    expect(message.parts).toEqual([
      {
        type: "tool-a",
        toolCallId: "ok",
        input: {},
        state: "output-available",
        output: { hits: 3 },
      },
      {
        type: "tool-b",
        toolCallId: "no",
        input: {},
        state: "output-denied",
        approval: { id: "", approved: false, reason: "needs approval" },
      },
      {
        type: "tool-c",
        toolCallId: "err",
        input: {},
        state: "output-error",
        errorText: "HTTP 500",
      },
    ]);
  });
});

describe("toTranscriptMessages — OpenAI chat histories stored by /v1", () => {
  const history = [
    { role: "developer", content: "You are support." },
    { role: "user", content: "where is order 7?" },
    {
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search_orders", arguments: '{"orderId":"7"}' },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "client_location", arguments: "not json" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' },
    {
      role: "tool",
      tool_call_id: "call_2",
      content: [{ type: "text", text: "Madrid" }],
    },
    { role: "assistant", content: "It shipped to Madrid." },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_3",
          type: "function",
          function: { name: "close_ticket", arguments: "{}" },
        },
      ],
    },
  ];

  it("turns tool_calls into tool parts paired with their tool messages, and developer into system", () => {
    const messages = toTranscriptMessages(history, "in");

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[2].parts).toEqual([
      { type: "text", text: "Let me check." },
      {
        type: "tool-search_orders",
        toolCallId: "call_1",
        input: { orderId: "7" },
        state: "output-available",
        output: '{"status":"shipped"}',
      },
      {
        type: "tool-client_location",
        toolCallId: "call_2",
        input: "not json",
        state: "output-available",
        output: "Madrid",
      },
    ]);
    expect(messages[4].parts).toEqual([{ type: "text", text: "thanks" }]);
    expect(messages[5].parts).toEqual([
      {
        type: "tool-close_ticket",
        toolCallId: "call_3",
        input: {},
        state: "input-available",
      },
    ]);
  });
});
