import { describe, expect, it, vi } from "vitest";

const recorder = {
  record: vi.fn(async () => "run-1"),
  attachTranscript: vi.fn(async () => {}),
  runId: () => "run-1",
};

vi.mock("@/lib/run-recorder", () => ({ createRecorder: () => recorder }));
vi.mock("@agentlathe/runner", () => ({
  loadActiveAgent: async () => ({ id: "agent-1", slug: "agent" }),
  openAIMessagesToModelMessages: (messages: unknown) => messages,
  buildHeadlessToolApproval: () => undefined,
  buildAgentRuntime: async () => ({
    agent: { generate: async () => ({ steps: [] }) },
    cleanup: async () => {},
    stats: () => ({}),
  }),
  toOpenAIChatCompletion: () => {
    throw new Error("serializer bug");
  },
  toOpenAIChatCompletionStream: vi.fn(),
}));

import { POST } from "./route";

describe("POST /v1/chat/completions — a run is recorded at most once", () => {
  it("a serialization failure after a recorded run answers 500 without recording it again", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "agent",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(res.status).toBe(500);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith({ stats: {} });
    expect(recorder.attachTranscript).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
