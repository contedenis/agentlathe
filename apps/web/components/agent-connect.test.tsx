import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentConnect } from "./agent-connect";

describe("AgentConnect", () => {
  it("fills both endpoints in with the agent's slug and this origin", () => {
    render(<AgentConnect slug="support-bot" />);
    const origin = window.location.origin;

    expect(screen.getByText(`${origin}/v1`)).toBeInTheDocument();
    expect(
      screen.getByText(`${origin}/mcp/agents/support-bot`),
    ).toBeInTheDocument();
    expect(screen.getByText("ask_support-bot")).toBeInTheDocument();
    expect(
      screen.getByText(/"url": ".*\/mcp\/agents\/support-bot"/),
    ).toBeInTheDocument();
  });

  it("shows one API example at a time, keeping the others mounted so the panel never changes size", async () => {
    render(<AgentConnect slug="support-bot" />);

    const panelOf = (text: RegExp) =>
      screen.getByText(text).closest('[role="tabpanel"]');

    expect(panelOf(/^curl /)).toHaveAttribute("aria-hidden", "false");
    expect(panelOf(/import OpenAI from "openai"/)).toHaveClass("invisible");

    await userEvent.click(screen.getByRole("tab", { name: "TypeScript" }));

    expect(panelOf(/import OpenAI from "openai"/)).not.toHaveClass("invisible");
    expect(panelOf(/^curl /)).toHaveClass("invisible");
    expect(screen.getByText(/model: "support-bot"/)).toBeInTheDocument();
  });
});
