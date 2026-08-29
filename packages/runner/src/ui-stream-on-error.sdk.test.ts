import { createAgentUIStream, stepCountIs, ToolLoopAgent } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const failingTurn = (error: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial answer" },
    { type: "error", error },
    { type: "finish", finishReason: "error", usage: usage(5, 2) },
  ]),
});

async function collectOnErrorArguments(
  providerError: unknown,
  options: { withOnEnd: boolean },
) {
  const agent = new ToolLoopAgent({
    model: new MockLanguageModelV4({
      doStream: [failingTurn(providerError)] as never,
    }) as never,
    instructions: "",
    stopWhen: stepCountIs(1),
  });

  const seen: unknown[] = [];
  const stream = await createAgentUIStream({
    agent,
    uiMessages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ],
    ...(options.withOnEnd ? { onEnd: async () => {} } : {}),
    onError: (error) => {
      seen.push(error);
      return "An error occurred.";
    },
  });

  for await (const _chunk of stream) {
  }
  return seen;
}

describe("createAgentUIStream onError, against the real SDK", () => {
  it("fires once with the provider error when no lifecycle callback is supplied", async () => {
    const providerError = new Error("provider exploded");

    const seen = await collectOnErrorArguments(providerError, {
      withOnEnd: false,
    });

    expect(seen).toEqual([providerError]);
  });

  it("fires a second time with its own masked output once onEnd is supplied", async () => {
    const providerError = new Error("provider exploded");

    const seen = await collectOnErrorArguments(providerError, {
      withOnEnd: true,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(providerError);
    expect(seen[1]).toBeInstanceOf(Error);
    expect((seen[1] as Error).message).toBe("An error occurred.");
  });

  it("loses the provider error when the handler assigns instead of coalescing", async () => {
    const providerError = new Error("provider exploded");

    const seen = await collectOnErrorArguments(providerError, {
      withOnEnd: true,
    });

    let assigned: unknown;
    let coalesced: unknown;
    for (const error of seen) {
      assigned = error;
      coalesced ??= error;
    }

    expect(assigned).not.toBe(providerError);
    expect(coalesced).toBe(providerError);
  });
});
