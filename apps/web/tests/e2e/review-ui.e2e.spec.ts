import { agentSlug } from "@agentlathe/db";
import { expect, test } from "@playwright/test";
import { APP_PORT } from "./port.mjs";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const STAMP = Date.now();
const AGENT_NAME = `Review UI ${STAMP}`;
const ERROR_TEXT = `Simulated failure ${STAMP}`;

let agentId = "";
let okRunId = "";
let errorRunId = "";
let editableAgentId = "";

test.beforeAll(async () => {
  const pool = stackPool();
  try {
    const agentResult = await pool.query(
      `insert into agents (name, slug, model, is_active) values ($1, $2, 'test/model', true) returning id`,
      [AGENT_NAME, agentSlug(AGENT_NAME)],
    );
    agentId = agentResult.rows[0].id;

    const okRunResult = await pool.query(
      `insert into agent_runs (agent_id, source, status, duration_ms, steps, tool_calls, input_tokens, output_tokens)
       values ($1, 'dashboard', 'ok', 1234, 3, 1, 120, 45) returning id`,
      [agentId],
    );
    okRunId = okRunResult.rows[0].id;

    const input = [{ role: "user", content: "que numero es?" }];
    const output = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "veamos" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "get_number",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", output: { number: 7 } },
        ],
      },
      { role: "assistant", content: "el numero es 7" },
    ];
    await pool.query(
      `insert into run_transcripts (run_id, input, output) values ($1, $2::jsonb, $3::jsonb)`,
      [okRunId, JSON.stringify(input), JSON.stringify(output)],
    );

    const errorRunResult = await pool.query(
      `insert into agent_runs (agent_id, source, status, duration_ms, steps, tool_calls, error)
       values ($1, 'dashboard', 'error', 500, 1, 0, $2) returning id`,
      [agentId, ERROR_TEXT],
    );
    errorRunId = errorRunResult.rows[0].id;
  } finally {
    await pool.end();
  }
});

test.describe("review UI", () => {
  test("shows counts and the failing agent on the home dashboard", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Home", level: 1 }),
    ).toBeVisible();

    const activeAgentsCard = page.getByRole("link", {
      name: /Active agents/,
    });
    await expect(activeAgentsCard).toBeVisible();
    const cardText = await activeAgentsCard.innerText();
    const match = cardText.match(/(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[0])).toBeGreaterThan(0);

    const needsReviewSection = page
      .locator("section")
      .filter({ has: page.getByText("Runs to review") });
    await expect(
      needsReviewSection.getByRole("link", { name: new RegExp(AGENT_NAME) }),
    ).toBeVisible();
  });

  test("searches the runs list by agent name", async ({ page }) => {
    await page.goto("/runs");
    const search = page.getByRole("textbox", { name: "Search by agent…" });
    await search.fill(AGENT_NAME);
    await page.waitForURL(/[?&]q=/);
    await expect(
      page.locator("table tbody tr").filter({
        has: page.locator(`a[href="/runs/${okRunId}"]`),
      }),
    ).toBeVisible();
  });

  test("filters the runs list by source and shows the error status", async ({
    page,
  }) => {
    await page.goto("/runs");
    await page.getByRole("button", { name: "Playground" }).click();
    await page.waitForURL(/source=dashboard/);

    const errorRow = page.locator("table tbody tr").filter({
      has: page.locator(`a[href="/runs/${errorRunId}"]`),
    });
    await expect(errorRow).toBeVisible();
    await expect(errorRow).toContainText("error");
  });

  test("annotates a tool call and runs its fix draft through its lifecycle", async ({
    page,
  }) => {
    await page.goto(`/runs/${okRunId}`);
    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "get_number" }),
    ).toBeVisible();

    await page.getByTitle("Note a fix: Tool: get_number").click();
    const dialog = page.getByRole("dialog", { name: "Note a fix" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Category").click();
    await page.getByRole("option", { name: "Tool definition" }).click();
    await dialog
      .getByLabel("Rationale")
      .fill("The tool result should be double-checked before answering.");
    await dialog.getByRole("button", { name: "Save note" }).click();

    await expect(page.getByText("Note saved.")).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tool definition (1)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Tool definition · The tool result should be double-checked/,
      }),
    ).toBeVisible();

    const fixDraftsHeader = page
      .locator("h3", { hasText: "Fix Drafts" })
      .locator("..");
    await expect(fixDraftsHeader.getByText("1 open")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit fix note" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Rationale")).toHaveValue(
      "The tool result should be double-checked before answering.",
    );
    await editDialog.getByLabel("Rationale").fill("Edited: verify the units.");
    await editDialog.getByLabel("Category").click();
    await page.getByRole("option", { name: "Tool approval policy" }).click();
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Note updated.")).toBeVisible();
    await expect(editDialog).not.toBeVisible();
    await expect(
      page.getByText("Edited: verify the units.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tool approval policy (1)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Tool approval policy · Edited: verify the units\./,
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Mark applied" }).click();
    await expect(page.getByText("Applied", { exact: true })).toBeVisible();
    await expect(fixDraftsHeader.getByText(/\d+ open/)).toHaveCount(0);

    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByText("Open", { exact: true })).toBeVisible();
    await expect(fixDraftsHeader.getByText("1 open")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
    await expect(fixDraftsHeader.getByText(/\d+ open/)).toHaveCount(0);
  });

  test("moves the metrics range with presets and custom dates", async ({
    page,
  }) => {
    await page.goto("/metrics");
    await expect(
      page.getByRole("heading", { name: "Metrics", level: 1 }),
    ).toBeVisible();

    await page.getByRole("button", { name: "7 d" }).click();
    await page.waitForURL(/days=7/);

    const today = new Date();
    const from = new Date(today.getTime() - 13 * 86_400_000);
    const fromValue = from.toISOString().slice(0, 10);
    const toValue = today.toISOString().slice(0, 10);

    await page.getByLabel("From", { exact: true }).fill(fromValue);
    await page.waitForURL(/from=/);
    await page.getByLabel("To", { exact: true }).fill(toValue);
    await page.waitForURL(/to=/);

    const byAgentCard = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "By agent" }),
    });
    await expect(
      byAgentCard.getByRole("link", { name: AGENT_NAME }),
    ).toBeVisible();
  });

  test("manages an agent's lifecycle through the UI", async ({ page }) => {
    const editableName = `Editable ${STAMP}`;
    const created = await fetch(`http://localhost:${APP_PORT}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editableName, model: "test/model" }),
    }).then((res) => res.json());
    editableAgentId = created.id;

    await page.goto(`/agents/${editableAgentId}`);
    await expect(
      page.getByRole("heading", { name: editableName, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForURL(`/agents/${editableAgentId}/edit`);

    const newDescription = `Edited description ${STAMP}`;
    await page.locator("#description").fill(newDescription);
    await page.locator("#maxSteps").fill("42");
    await page.getByRole("button", { name: "Save" }).click();

    await page.waitForURL(`/agents/${editableAgentId}`);
    await expect(page.getByText("Agent updated.")).toBeVisible();
    await expect(page.locator("dd", { hasText: newDescription })).toBeVisible();
    await expect(page.locator("dd", { hasText: /^42$/ })).toBeVisible();

    await page.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("Deactivated.")).toBeVisible();
    await expect(page.getByText("inactive", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("Activated.")).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete the agent" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await page.waitForURL("/agents");
    await expect(page.getByText("Deleted the agent.")).toBeVisible();
    await expect(page.getByRole("button", { name: editableName })).toHaveCount(
      0,
    );
  });

  test("creates and deletes a tool via the UI", async ({ page }) => {
    const toolName = `E2E Tool ${STAMP}`;
    await page.goto("/tools");
    await page.getByRole("button", { name: "New tool" }).click();

    const sheet = page.getByRole("dialog", { name: "New tool" });
    await expect(sheet).toBeVisible();
    await sheet.locator("#name").fill(toolName);
    await sheet.locator("#description").fill("Throwaway e2e tool.");
    await sheet.locator("#endpoint").fill("https://example.com/e2e-tool");
    await sheet.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Tool created.")).toBeVisible();
    await expect(page.getByRole("button", { name: toolName })).toBeVisible();

    const row = page.locator("table tbody tr").filter({ hasText: toolName });
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete the tool" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(page.getByText("Deleted the tool.")).toBeVisible();
    await expect(page.getByRole("button", { name: toolName })).toHaveCount(0);
  });

  test("creates and deletes a skill via the UI", async ({ page }) => {
    const skillName = `E2E Skill ${STAMP}`;
    await page.goto("/skills");
    await page.getByRole("button", { name: "New skill" }).click();

    const sheet = page.getByRole("dialog", { name: "New skill" });
    await expect(sheet).toBeVisible();
    await sheet.locator("#name").fill(skillName);
    await sheet.locator("#description").fill("Throwaway e2e skill.");
    await sheet.locator("#content").fill("Some throwaway skill content.");
    await sheet.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Skill created.")).toBeVisible();
    await expect(page.getByRole("button", { name: skillName })).toBeVisible();

    const row = page.locator("table tbody tr").filter({ hasText: skillName });
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete the skill" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(page.getByText("Deleted the skill.")).toBeVisible();
    await expect(page.getByRole("button", { name: skillName })).toHaveCount(0);
  });

  test("creates and deletes an MCP server via the UI", async ({ page }) => {
    const serverName = `E2E MCP ${STAMP}`;
    await page.goto("/mcp-servers");
    await page.getByRole("button", { name: "New server" }).click();

    const sheet = page.getByRole("dialog", { name: "New MCP server" });
    await expect(sheet).toBeVisible();
    await sheet.locator("#name").fill(serverName);
    await sheet.locator("#serverUrl").fill("https://example.com/e2e-mcp");
    await sheet.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("MCP server created.")).toBeVisible();
    await expect(page.getByRole("button", { name: serverName })).toBeVisible();

    const row = page.locator("table tbody tr").filter({ hasText: serverName });
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Delete the MCP server" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(page.getByText("Deleted the MCP server.")).toBeVisible();
    await expect(page.getByRole("button", { name: serverName })).toHaveCount(0);
  });
});
