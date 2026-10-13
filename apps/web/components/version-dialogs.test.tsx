import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { diffVersions, readSnapshot } from "@/lib/version-diff";
import { VersionChangesDialog, VersionConfigDialog } from "./version-dialogs";

const before = {
  model: "vendor/model-a",
  systemPrompt: "Be kind.\nNever promise refunds.",
  maxSteps: 10,
  skills: [],
  httpTools: [
    {
      name: "Lookup order",
      description: "Finds an order",
      endpoint: "https://api.example.com",
      inputSchema: { type: "object" },
      needsApproval: false,
    },
  ],
  mcpServers: [],
  subAgents: [],
  descendants: [],
};

const after = {
  ...before,
  model: "vendor/model-b",
  systemPrompt: "Be kind.\nAsk before promising refunds.",
  skills: [{ name: "Refunds", description: "Policy", content: "Ask first." }],
  httpTools: [],
};

describe("VersionChangesDialog", () => {
  it("opens on what changed and shows only the sections that changed", async () => {
    const user = userEvent.setup();
    render(
      <VersionChangesDialog
        shortHash="bbbbbbbb"
        previousShortHash="aaaaaaaa"
        changes={diffVersions(before, after)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "What changed" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText(/Changes in/)).toHaveTextContent(
      "Changes in bbbbbbbb",
    );
    expect(within(dialog).getByText(/Compared with/)).toHaveTextContent(
      "Compared with aaaaaaaa",
    );
    expect(within(dialog).getByText("vendor/model-a")).toHaveClass(
      "line-through",
    );
    expect(within(dialog).getByText("vendor/model-b")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Never promise refunds."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Ask before promising refunds."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Skills")).toBeInTheDocument();
    expect(within(dialog).getByText("Refunds")).toBeInTheDocument();
    expect(within(dialog).getByText("added")).toBeInTheDocument();
    expect(within(dialog).getByText("Lookup order")).toBeInTheDocument();
    expect(within(dialog).getByText("removed")).toBeInTheDocument();
    expect(within(dialog).queryByText("MCP servers")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Sub-agents")).not.toBeInTheDocument();
  });

  it("explains an empty diff instead of showing nothing", async () => {
    const user = userEvent.setup();
    render(
      <VersionChangesDialog
        shortHash="bbbbbbbb"
        previousShortHash="aaaaaaaa"
        changes={diffVersions(before, before)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "What changed" }));

    expect(
      screen.getByText(/Nothing that can be shown changed/),
    ).toBeInTheDocument();
  });
});

describe("VersionConfigDialog", () => {
  it("opens from the short hash and shows the configuration the run used", async () => {
    const user = userEvent.setup();
    render(
      <VersionConfigDialog
        shortHash="aaaaaaaa"
        config={readSnapshot(before)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "aaaaaaaa" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("vendor/model-a")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Never promise refunds\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Lookup order")).toBeInTheDocument();
    expect(
      within(dialog).getByText("https://api.example.com"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Skills")).not.toBeInTheDocument();
  });
});
