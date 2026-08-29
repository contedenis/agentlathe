import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlayground } from "./agent-playground";

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentPlayground", () => {
  it("renders the approval banner from a streamed approval-requested part and posts the approved response on Approve", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: "start", messageId: "assistant-1" },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "danger",
          input: { target: "prod" },
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "call-1",
        },
        { type: "finish-step" },
        { type: "finish", finishReason: "tool-calls" },
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        { type: "start", messageId: "assistant-2" },
        { type: "start-step" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Understood." },
        { type: "text-end", id: "t1" },
        { type: "finish-step" },
        { type: "finish", finishReason: "stop" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentPlayground agentId="agent-1" />);

    await user.type(
      screen.getByPlaceholderText(/Write a message/),
      "clean the workspace",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(
        "The agent wants to run a tool that needs your approval",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("danger", { selector: "code" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("Understood.");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(
      fetchMock.mock.calls[1][1].body as string,
    );
    const respondedPart = secondCallBody.messages
      .at(-1)
      .parts.find(
        (part: { toolCallId?: string }) => part.toolCallId === "call-1",
      );
    expect(respondedPart).toMatchObject({
      state: "approval-responded",
      approval: { id: "approval-1", approved: true },
    });
  });

  it("renders a run link from a data-run part", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          { type: "start", messageId: "assistant-1" },
          { type: "start-step" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "hi" },
          { type: "text-end", id: "t1" },
          { type: "finish-step" },
          { type: "data-run", data: { runId: "run-123" } },
          { type: "finish", finishReason: "stop" },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentPlayground agentId="agent-1" />);

    await user.type(screen.getByPlaceholderText(/Write a message/), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const runLink = await screen.findByRole("link", { name: "Open run" });
    expect(runLink).toHaveAttribute("href", "/runs/run-123");
  });
});
