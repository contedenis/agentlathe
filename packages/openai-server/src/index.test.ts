import type {
  FinishReason,
  LanguageModelUsage,
  TextStreamPart,
  ToolSet,
} from "ai";
import { describe, expect, it } from "vitest";
import {
  openAIMessagesToModelMessages,
  toOpenAIChatCompletion,
  toOpenAIChatCompletionStream,
} from "./index";

function mkUsage(
  input: number,
  output: number,
  total?: number,
): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total ?? input + output,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  };
}

function baseResult(overrides: {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults?: Array<{ toolCallId: string }>;
  finishReason?: FinishReason;
}) {
  return {
    text: overrides.text ?? "",
    toolCalls: overrides.toolCalls ?? [],
    toolResults: overrides.toolResults ?? [],
    usage: mkUsage(10, 5),
    finishReason: overrides.finishReason ?? "stop",
    response: { id: "resp-123", timestamp: new Date(1_700_000_000_000) },
  };
}

describe("toOpenAIChatCompletion", () => {
  it("text result → correct chat.completion shape", () => {
    const out = toOpenAIChatCompletion(
      baseResult({ text: "Hola mundo", finishReason: "stop" }),
      "asistente",
    );

    expect(out.object).toBe("chat.completion");
    expect(out.id).toBe("resp-123");
    expect(out.created).toBe(1_700_000_000);
    expect(out.model).toBe("asistente");
    expect(out.choices).toHaveLength(1);
    expect(out.choices[0]).toMatchObject({
      index: 0,
      message: { role: "assistant", content: "Hola mundo" },
      finish_reason: "stop",
    });
    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("result with toolCalls → well-formed tool_calls, null content, finish_reason tool_calls", () => {
    const out = toOpenAIChatCompletion(
      baseResult({
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "get_weather",
            input: { city: "BA" },
          },
        ],
        finishReason: "tool-calls",
      }),
      "asistente",
    );

    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"BA"}' },
      },
    ]);
  });

  it("internal tool call (with a toolResult) is filtered out: content present and no tool_calls", () => {
    const out = toOpenAIChatCompletion(
      baseResult({
        text: "LISTO",
        toolCalls: [
          { toolCallId: "call_int", toolName: "webhook", input: { m: "x" } },
        ],
        toolResults: [{ toolCallId: "call_int" }],
        finishReason: "stop",
      }),
      "m",
    );

    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].message.content).toBe("LISTO");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  it("unresolved call at finish stop (denied or errored server-side) is not emitted as tool_calls", () => {
    const out = toOpenAIChatCompletion(
      baseResult({
        text: "Done, the notification is pending approval.",
        toolCalls: [
          { toolCallId: "call_ok", toolName: "classify", input: {} },
          { toolCallId: "call_denied", toolName: "notify", input: { m: "x" } },
        ],
        toolResults: [{ toolCallId: "call_ok" }],
        finishReason: "stop",
      }),
      "m",
    );

    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].message.content).toBe(
      "Done, the notification is pending approval.",
    );
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  it("id/created are injectable for determinism", () => {
    const out = toOpenAIChatCompletion(baseResult({ text: "x" }), "m", {
      id: "chatcmpl-fixed",
      created: 42,
    });
    expect(out.id).toBe("chatcmpl-fixed");
    expect(out.created).toBe(42);
  });
});

function toStream(
  parts: TextStreamPart<ToolSet>[],
): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  };
}

async function readChunks(response: Response) {
  const text = await response.text();
  const frames = text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f && !f.startsWith(":"))
    .map((f) => f.replace(/^data: /, ""));
  const done = frames.at(-1) === "[DONE]";
  const chunks = frames.filter((f) => f !== "[DONE]").map((f) => JSON.parse(f));
  return { chunks, done, raw: text };
}

describe("toOpenAIChatCompletionStream", () => {
  it("text-delta → first chunk with role, content deltas, finish and [DONE]", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "Hola" },
      { type: "text-delta", id: "t1", text: " mundo" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(3, 4),
      },
    ];

    const res = toOpenAIChatCompletionStream(toStream(parts), "asistente", {
      id: "chatcmpl-1",
      created: 100,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const { chunks, done } = await readChunks(res);
    expect(done).toBe(true);

    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(chunks[0]).toMatchObject({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 100,
      model: "asistente",
    });

    expect(chunks[1].choices[0].delta).toEqual({ content: "Hola" });
    expect(chunks[2].choices[0].delta).toEqual({ content: " mundo" });

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.choices[0].finish_reason).toBeNull();
    }

    const last = chunks.at(-1);
    expect(last.choices[0].delta).toEqual({});
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toBeUndefined();
  });

  it("usage: ONLY with include_usage, in its own chunk with choices:[] after finish and before [DONE]", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(3, 4),
      },
    ];

    const { chunks, done } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
        includeUsage: true,
      }),
    );

    expect(done).toBe(true);
    const finish = chunks.at(-2);
    const usageChunk = chunks.at(-1);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toBeUndefined();
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
  });

  it("emits SSE keep-alive comments while the stream is silent, invisible to the chunk parser", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "working" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];
    const slowStream: AsyncIterable<TextStreamPart<ToolSet>> = {
      async *[Symbol.asyncIterator]() {
        for (const part of parts) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield part;
        }
      },
    };

    const { chunks, done, raw } = await readChunks(
      toOpenAIChatCompletionStream(slowStream, "m", {
        id: "x",
        created: 0,
        heartbeatMs: 10,
      }),
    );

    expect(raw).toContain(": keep-alive\n\n");
    expect(done).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("internal tool call (with a later tool-result) is FILTERED OUT: the /v1 client never sees it", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-input-start", id: "call_x", toolName: "search" },
      { type: "tool-input-delta", id: "call_x", delta: '{"q":"hi"}' },
      {
        type: "tool-call",
        toolCallId: "call_x",
        toolName: "search",
        input: { q: "hi" },
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-result",
        toolCallId: "call_x",
        toolName: "search",
        input: { q: "hi" },
        output: "ok",
      } as TextStreamPart<ToolSet>,
      { type: "text-delta", id: "t1", text: "listo" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
      }),
    );

    for (const chunk of chunks)
      expect(chunk.choices[0]?.delta?.tool_calls).toBeUndefined();
    expect(chunks.some((c) => c.choices[0]?.delta?.content === "listo")).toBe(
      true,
    );
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("tool call that FAILED server-side (tool-error) is filtered out: the /v1 client never sees it", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-input-start", id: "call_err", toolName: "search" },
      { type: "tool-input-delta", id: "call_err", delta: '{"q":"hi"}' },
      {
        type: "tool-call",
        toolCallId: "call_err",
        toolName: "search",
        input: { q: "hi" },
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-error",
        toolCallId: "call_err",
        toolName: "search",
        input: { q: "hi" },
        error: new Error("the tool endpoint could not be reached"),
      } as TextStreamPart<ToolSet>,
      { type: "text-delta", id: "t1", text: "no pude buscar" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
      }),
    );

    for (const chunk of chunks)
      expect(chunk.choices[0]?.delta?.tool_calls).toBeUndefined();
    expect(
      chunks.some((c) => c.choices[0]?.delta?.content === "no pude buscar"),
    ).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("tool call DENIED server-side (tool-output-denied) is filtered out: the /v1 client never sees it", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-input-start", id: "call_denied", toolName: "notify" },
      { type: "tool-input-delta", id: "call_denied", delta: '{"m":"x"}' },
      {
        type: "tool-call",
        toolCallId: "call_denied",
        toolName: "notify",
        input: { m: "x" },
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-output-denied",
        toolCallId: "call_denied",
        toolName: "notify",
      } as TextStreamPart<ToolSet>,
      { type: "text-delta", id: "t1", text: "no envié la notificación" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
      }),
    );

    for (const chunk of chunks)
      expect(chunk.choices[0]?.delta?.tool_calls).toBeUndefined();
    expect(
      chunks.some(
        (c) => c.choices[0]?.delta?.content === "no envié la notificación",
      ),
    ).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("a resolved call and a still-pending one in the same stream: only the pending one is emitted", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      {
        type: "tool-call",
        toolCallId: "call_denied",
        toolName: "notify",
        input: { m: "x" },
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-output-denied",
        toolCallId: "call_denied",
        toolName: "notify",
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-call",
        toolCallId: "call_client",
        toolName: "lookup",
        input: { id: 7 },
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
      }),
    );

    const emitted = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
      .map((call: { id: string }) => call.id);
    expect(emitted).toEqual(["call_client"]);
  });

  it("complete tool-call with no prior deltas → fallback: emitted with its index", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      {
        type: "tool-call",
        toolCallId: "call_z",
        toolName: "lookup",
        input: { id: 7 },
      } as TextStreamPart<ToolSet>,
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "x",
        created: 0,
      }),
    );

    const toolChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_z",
      type: "function",
      function: { name: "lookup", arguments: '{"id":7}' },
    });
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("onDone fires when the stream finishes being consumed, with errored: false", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    let doneCalls = 0;
    let lastResult: { errored: boolean; error?: unknown } | undefined;
    const res = toOpenAIChatCompletionStream(
      toStream(parts),
      "m",
      { id: "x", created: 0 },
      (result) => {
        doneCalls += 1;
        lastResult = result;
      },
    );

    await readChunks(res);
    expect(doneCalls).toBe(1);
    expect(lastResult).toEqual({ errored: false, error: undefined });
  });

  it("consumer cancel → onDone runs exactly once with errored: false and fires onCancel (aborting the run)", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "a" },
      { type: "text-delta", id: "t1", text: "b" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 1),
      },
    ];

    let doneCalls = 0;
    let cancelCalls = 0;
    let lastResult: { errored: boolean; error?: unknown } | undefined;
    const res = toOpenAIChatCompletionStream(
      toStream(parts),
      "m",
      { id: "x", created: 0 },
      (result) => {
        doneCalls += 1;
        lastResult = result;
      },
      () => {
        cancelCalls += 1;
      },
    );

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelCalls).toBe(1);
    expect(doneCalls).toBe(1);
    expect(lastResult).toEqual({ errored: false });
  });

  it("TWO parallel tool calls → distinct indexes and concatenable arguments", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-input-start", id: "call_a", toolName: "search" },
      { type: "tool-input-start", id: "call_b", toolName: "lookup" },
      { type: "tool-input-delta", id: "call_a", delta: '{"q":' },
      { type: "tool-input-delta", id: "call_b", delta: '{"id":' },
      { type: "tool-input-delta", id: "call_a", delta: '"hi"}' },
      { type: "tool-input-delta", id: "call_b", delta: "42}" },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: undefined,
        totalUsage: mkUsage(1, 2),
      },
    ];

    const { chunks } = await readChunks(
      toOpenAIChatCompletionStream(toStream(parts), "m", {
        id: "chatcmpl-2",
        created: 1,
      }),
    );

    const argsByIndex = new Map<number, string>();
    const idByIndex = new Map<number, string>();
    const nameByIndex = new Map<number, string>();
    for (const chunk of chunks) {
      const toolCalls = chunk.choices[0].delta.tool_calls;
      if (!toolCalls) continue;
      for (const tc of toolCalls) {
        if (tc.id) idByIndex.set(tc.index, tc.id);
        if (tc.function?.name) nameByIndex.set(tc.index, tc.function.name);
        argsByIndex.set(
          tc.index,
          (argsByIndex.get(tc.index) ?? "") + (tc.function?.arguments ?? ""),
        );
      }
    }

    expect(idByIndex.get(0)).toBe("call_a");
    expect(nameByIndex.get(0)).toBe("search");
    expect(idByIndex.get(1)).toBe("call_b");
    expect(nameByIndex.get(1)).toBe("lookup");

    expect(JSON.parse(argsByIndex.get(0) as string)).toEqual({ q: "hi" });
    expect(JSON.parse(argsByIndex.get(1) as string)).toEqual({ id: 42 });

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.choices[0].finish_reason).toBeNull();
    }

    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("error part → error frame, no clean [DONE] close, and onDone fires with errored: true and the error", async () => {
    const upstreamError = new Error("upstream boom");
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "t1", text: "Hola" },
      { type: "error", error: upstreamError },
    ];

    let lastResult: { errored: boolean; error?: unknown } | undefined;
    const { chunks, done } = await readChunks(
      toOpenAIChatCompletionStream(
        toStream(parts),
        "m",
        { id: "x", created: 0 },
        (result) => {
          lastResult = result;
        },
      ),
    );

    expect(done).toBe(false);
    expect(chunks.at(-1).error).toEqual({
      message: "upstream boom",
      type: "api_error",
    });
    expect(lastResult).toEqual({ errored: true, error: upstreamError });
  });

  it("iterator throw → error frame, no [DONE], and onDone fires with errored: true and the caught error", async () => {
    const thrown = new Error("iterator exploded");
    const throwing: AsyncIterable<TextStreamPart<ToolSet>> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", id: "t1", text: "Hola" };
        throw thrown;
      },
    };

    let doneCalls = 0;
    let lastResult: { errored: boolean; error?: unknown } | undefined;
    const { chunks, done } = await readChunks(
      toOpenAIChatCompletionStream(
        throwing,
        "m",
        { id: "x", created: 0 },
        (result) => {
          doneCalls += 1;
          lastResult = result;
        },
      ),
    );

    expect(done).toBe(false);
    expect(chunks.at(-1).error).toEqual({
      message: "iterator exploded",
      type: "api_error",
    });
    expect(doneCalls).toBe(1);
    expect(lastResult).toEqual({ errored: true, error: thrown });
  });
});

describe("openAIMessagesToModelMessages", () => {
  it("system/user/assistant string → ModelMessage[]", () => {
    const out = openAIMessagesToModelMessages([
      { role: "system", content: "Sos un asistente." },
      { role: "user", content: "Hola" },
      { role: "assistant", content: "Buenas" },
    ]);

    expect(out).toEqual([
      { role: "system", content: "Sos un asistente." },
      { role: "user", content: "Hola" },
      { role: "assistant", content: "Buenas" },
    ]);
  });

  it("role developer → maps to system", () => {
    const out = openAIMessagesToModelMessages([
      { role: "developer", content: "System rules." },
    ]);
    expect(out).toEqual([{ role: "system", content: "System rules." }]);
  });

  it("user content array → concatenates text parts only", () => {
    const out = openAIMessagesToModelMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "parte1 " },
          { type: "image_url", image_url: { url: "http://x" } },
          { type: "text", text: "parte2" },
        ],
      },
    ]);
    expect(out).toEqual([{ role: "user", content: "parte1 parte2" }]);
  });

  it("assistant with tool_calls + tool result → ToolCallPart and ToolResultPart with the name resolved", () => {
    const out = openAIMessagesToModelMessages([
      { role: "user", content: "clima?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "get_weather", arguments: '{"city":"BA"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "soleado" },
    ]);

    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "get_weather",
          input: { city: "BA" },
        },
      ],
    });
    expect(out[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "get_weather",
          output: { type: "text", value: "soleado" },
        },
      ],
    });
  });

  it("tool_calls with invalid JSON arguments → degrades: input stays as the raw string, no throw", () => {
    const out = openAIMessagesToModelMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            function: { name: "do_it", arguments: "{no es json" },
          },
        ],
      },
    ]);

    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_bad",
          toolName: "do_it",
          input: "{no es json",
        },
      ],
    });
  });

  it("orphan tool (tool_call_id with no prior tool_call) → toolName falls back to the id, still emitted", () => {
    const out = openAIMessagesToModelMessages([
      { role: "tool", tool_call_id: "fantasma", content: "resultado" },
    ]);

    expect(out).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "fantasma",
            toolName: "fantasma",
            output: { type: "text", value: "resultado" },
          },
        ],
      },
    ]);
  });

  it("tool with no tool_call_id → toolCallId and toolName end up as empty strings", () => {
    const out = openAIMessagesToModelMessages([
      { role: "tool", content: "huerfano total" },
    ]);

    expect(out).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "",
            toolName: "",
            output: { type: "text", value: "huerfano total" },
          },
        ],
      },
    ]);
  });

  it("unknown roles are ignored (not added to the result)", () => {
    const out = openAIMessagesToModelMessages([
      { role: "function", content: "legacy" },
      { role: "banana", content: "?" },
      { role: "user", content: "hola" },
    ]);

    expect(out).toEqual([{ role: "user", content: "hola" }]);
  });

  it("assistant with a content array → concatenates text parts only, drops non-text ones", () => {
    const out = openAIMessagesToModelMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "hola " },
          { type: "refusal", refusal: "no" },
          { type: "text", text: "mundo" },
        ],
      },
    ]);

    expect(out).toEqual([{ role: "assistant", content: "hola mundo" }]);
  });
});
