import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { KnowledgeLink } from "@/lib/knowledge-modes";
import { KnowledgePicker } from "./knowledge-picker";

const collections = [
  { id: "c1", name: "Policies", description: "HR.", chars: 40_000 },
  { id: "c2", name: "Notes", description: "", chars: 8_000 },
];

function Harness() {
  const [value, setValue] = useState<KnowledgeLink[]>([]);
  return (
    <KnowledgePicker
      collections={collections}
      value={value}
      onChange={setValue}
      contextLength={200_000}
    />
  );
}

async function setMode(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  mode: string,
) {
  await user.click(
    screen.getByRole("combobox", { name: `How the agent uses ${name}` }),
  );
  await user.click(await screen.findByRole("option", { name: mode }));
}

describe("KnowledgePicker", () => {
  it("brings a collection back with the mode it had, and counts it again", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const add = () =>
      screen.getByRole("combobox", { name: "Add a collection" });

    await user.type(add(), "pol{Enter}");
    await setMode(user, "Policies", "Always read");
    expect(
      screen.getByText(/Read whole: about 10,000 tokens/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Policies" }));
    expect(screen.queryByText(/Read whole/)).toBeNull();

    await user.type(add(), "pol{Enter}");
    expect(
      screen.getByRole("combobox", { name: "How the agent uses Policies" }),
    ).toHaveTextContent("Always read");
    expect(
      screen.getByText(/Read whole: about 10,000 tokens/),
    ).toBeInTheDocument();

    await user.type(add(), "not{Enter}");
    expect(
      screen.getByRole("combobox", { name: "How the agent uses Notes" }),
    ).toHaveTextContent("Search");
    await setMode(user, "Notes", "Always read");
    expect(
      screen.getByText(/Read whole: about 12,000 tokens/),
    ).toBeInTheDocument();
  });
});
