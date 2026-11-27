import { tool, type UIMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, buildProvider: vi.fn() };
});

import { streamBuilderForUI } from "./builder";
import { buildProvider } from "./helpers";

const usage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

let callCount = 0;
const proposeTurn = (input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-${++callCount}`,
      toolName: "propose",
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: "tool-calls", usage },
  ]),
});

const textTurn = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ]),
});

const user: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "an agent for refunds" }],
};

const propose = tool({
  description: "Presents a proposal.",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    if (name === "Taken") throw new Error('An agent named "Taken" exists.');
    return { presented: true };
  },
});

const chunks = async (response: Response) =>
  (await response.text())
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);

beforeEach(() => {
  callCount = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("streamBuilderForUI against the real SDK", () => {
  it("hands a rejected proposal back to the model, which corrects it in the same turn", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        proposeTurn({ name: "Taken" }),
        proposeTurn({ name: "Refund desk" }),
        textTurn("Proposed Refund desk."),
      ] as never,
    });
    vi.mocked(buildProvider).mockReturnValue(model as never);

    const stream = await chunks(
      await streamBuilderForUI({
        model: "vendor/model",
        instructions: "You build agents.",
        tools: { propose },
        messages: [user],
      }),
    );

    expect(buildProvider).toHaveBeenCalledWith("vendor/model");
    expect(model.doStreamCalls).toHaveLength(3);
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "tool-output-error",
        errorText: 'An agent named "Taken" exists.',
      }),
    );
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "tool-output-available",
        output: { presented: true },
      }),
    );
    expect(stream.at(-1)).toMatchObject({ type: "finish" });
  });

  it("tells the person what failed when the model call does", async () => {
    vi.mocked(buildProvider).mockReturnValue(
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("No endpoints found for vendor/typo.");
        },
      }) as never,
    );

    const stream = await chunks(
      await streamBuilderForUI({
        model: "vendor/typo",
        instructions: "",
        tools: {},
        messages: [user],
      }),
    );

    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "error",
        errorText: expect.stringContaining("No endpoints found"),
      }),
    );
  });

  it("ends with a notice when the run time limit passes", async () => {
    vi.stubEnv("RUN_TIMEOUT_SECONDS", "0.05");
    vi.mocked(buildProvider).mockReturnValue(
      new MockLanguageModelV4({
        doStream: (({ abortSignal }: { abortSignal?: AbortSignal }) =>
          new Promise<never>((_, reject) =>
            abortSignal?.addEventListener("abort", () =>
              reject(abortSignal.reason),
            ),
          )) as never,
      }) as never,
    );

    const stream = await chunks(
      await streamBuilderForUI({
        model: "vendor/model",
        instructions: "",
        tools: {},
        messages: [user],
      }),
    );

    expect(stream).toContainEqual({
      type: "error",
      errorText: "The builder exceeded its time limit.",
    });
  });
});
