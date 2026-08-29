import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type MessagePart, ToolCallDisplay } from "./tool-call-display";

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

function toolPart(part: Record<string, unknown>): MessagePart {
  return part as unknown as MessagePart;
}

describe("ToolCallDisplay", () => {
  it("renders the approval banner state with the pending input, expanded by default", () => {
    render(
      <ToolCallDisplay
        part={toolPart({
          type: "tool-danger",
          toolCallId: "call-1",
          state: "approval-requested",
          input: { target: "prod" },
          approval: { id: "appr-1" },
        })}
      />,
    );

    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText("danger")).toBeInTheDocument();
    expect(screen.getByText(/"target": "prod"/)).toBeInTheDocument();
  });

  it("renders the denial reason for an output-denied tool part", () => {
    render(
      <ToolCallDisplay
        part={toolPart({
          type: "tool-danger",
          toolCallId: "call-1",
          state: "output-denied",
          input: { target: "prod" },
          approval: { id: "appr-1", approved: false, reason: "Too risky." },
        })}
      />,
    );

    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(screen.getByText("Too risky.")).toBeInTheDocument();
  });

  it("renders the completed output once expanded", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallDisplay
        part={toolPart({
          type: "tool-search",
          toolCallId: "call-2",
          state: "output-available",
          input: { query: "hello" },
          output: { count: 3 },
        })}
      />,
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText(/"count": 3/)).not.toBeInTheDocument();

    await user.click(screen.getByText("search"));

    expect(await screen.findByText(/"count": 3/)).toBeInTheDocument();
  });
});
