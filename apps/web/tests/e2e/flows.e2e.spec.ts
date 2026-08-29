import { expect, test } from "@playwright/test";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";
const MODEL_TIMEOUT = 60_000;
const AGENT_NAME = `E2E Agent ${Date.now()}`;

let agentId = "";
let firstRunId = "";

test.describe("agentlathe e2e flows", () => {
  test("creates an agent via the UI", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.getByRole("heading", { name: "Agents", level: 1 }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(
      page.getByRole("heading", { name: "New agent", level: 1 }),
    ).toBeVisible();

    await page.locator("#name").fill(AGENT_NAME);

    const model = page.locator("#model");
    await model.click();
    await model.pressSequentially(MODEL, { delay: 10 });
    await page.getByRole("option", { name: MODEL }).first().click();
    await expect(model).toHaveValue(MODEL);

    await page.getByRole("button", { name: "Edit in canvas" }).click();
    const dialog = page.getByRole("dialog", { name: "Prompt editor" });
    await expect(dialog).toBeVisible();
    const editor = dialog.locator(".cm-content");
    await editor.click();
    await page.keyboard.type(
      "You are a test agent. When asked for the number, you MUST call the get_number tool and answer including its numeric result. When asked to clean the workspace, you MUST call the dangerous_cleanup tool.",
    );
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).not.toBeVisible();

    await page.getByRole("checkbox", { name: "get_number" }).click();
    await page.getByRole("checkbox", { name: "dangerous_cleanup" }).click();
    await expect(
      page.getByRole("checkbox", { name: "get_number" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("checkbox", { name: "dangerous_cleanup" }),
    ).toHaveAttribute("aria-checked", "true");

    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);

    agentId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("runs a playground chat that calls a tool", async ({ page }) => {
    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    await input.fill("What is the number right now? Use your tool.");
    await input.press("Enter");

    await expect(
      page.locator('[role="log"] .is-assistant').last(),
    ).toContainText(/7/, {
      timeout: MODEL_TIMEOUT,
    });

    await expect(
      page.getByRole("button", { name: "get_number" }).last(),
    ).toBeVisible();
    await expect(page.getByText("Completed").last()).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Note a fix" }).last(),
    ).toBeVisible();
    const openRunLink = page.getByRole("link", { name: "Open run" }).last();
    await expect(openRunLink).toBeVisible();
    const href = await openRunLink.getAttribute("href");
    firstRunId = (href ?? "").split("/").pop() ?? "";
    expect(firstRunId).toMatch(/^[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Note a fix" }).last().click();
    const dialog = page.getByRole("dialog", { name: "Note a fix" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Rationale").fill("Playground note to keep.");
    await dialog.getByRole("button", { name: "Save note" }).click();
    await expect(dialog).not.toBeVisible();

    const chip = page.getByRole("button", {
      name: /System prompt · Playground note to keep\./,
    });
    await expect(chip).toBeVisible();

    await chip.click();
    const editDialog = page.getByRole("dialog", { name: "Edit fix note" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Rationale")).toHaveValue(
      "Playground note to keep.",
    );
    await editDialog.getByLabel("Rationale").fill("Playground note, edited.");
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Note updated.")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /System prompt · Playground note, edited\./,
      }),
    ).toBeVisible();
  });

  test("approves a tool call that needs approval", async ({ page }) => {
    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    await input.fill(
      "Clean the workspace now. Call the dangerous_cleanup tool.",
    );
    await input.press("Enter");

    const banner = page.getByText(
      "The agent wants to run a tool that needs your approval",
    );
    await expect(banner).toBeVisible({ timeout: MODEL_TIMEOUT });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(banner).not.toBeVisible();

    await expect(
      page.getByRole("button", { name: "dangerous_cleanup" }).last(),
    ).toBeVisible();
    await expect(page.getByText("Completed").last()).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });
  });

  test("denies a tool call that needs approval", async ({ page }) => {
    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    await input.fill(
      "Clean the workspace now. Call the dangerous_cleanup tool.",
    );
    await input.press("Enter");

    const banner = page.getByText(
      "The agent wants to run a tool that needs your approval",
    );
    await expect(banner).toBeVisible({ timeout: MODEL_TIMEOUT });
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(banner).not.toBeVisible();

    await expect(page.getByText("Responded").last()).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });
    await expect(
      page.getByRole("button", { name: "Note a fix" }).last(),
    ).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });

    // The denial lands with the follow-up turn: leaving early makes the metrics test see 0.
    const pool = stackPool();
    try {
      await expect
        .poll(
          async () => {
            const { rows } = await pool.query(
              `select count(*)::int as denied
               from agent_run_calls c
               join agent_runs r on r.id = c.run_id
               where r.agent_id = $1 and c.status = 'denied'
                 and c.name = 'dangerous_cleanup'`,
              [agentId],
            );
            return rows[0].denied as number;
          },
          { timeout: MODEL_TIMEOUT },
        )
        .toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  test("adds a fix draft from a run and sees it reflected in the runs list", async ({
    page,
  }) => {
    await page.goto(`/runs/${firstRunId}`);

    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(page.locator(".is-user").first()).toBeVisible();
    await expect(page.locator(".is-assistant").first()).toBeVisible();

    const noteButton = page.getByTitle("Note a fix: Turn").first();
    await noteButton.click();

    const dialog = page.getByRole("dialog", { name: "Note a fix" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Rationale")
      .fill("The agent should include the units of the number.");
    await dialog.getByRole("button", { name: "Save note" }).click();

    await expect(page.getByText("Note saved.")).toBeVisible();
    await expect(dialog).not.toBeVisible();

    // Two open notes: the playground chip flow's plus this one.
    await expect(
      page.getByRole("heading", { name: "System prompt (2)" }),
    ).toBeVisible();

    await page.goto("/runs");
    // Scoped to main: dev mode can leave a stale copy of the table detached under <body>.
    const runRow = page.locator("main table tbody tr").filter({
      has: page.locator(`a[href="/runs/${firstRunId}"]`),
    });
    await expect(runRow).toContainText("2 open");
  });

  test("shows aggregated metrics for the agent and its capabilities", async ({
    page,
  }) => {
    await page.goto("/metrics");

    await expect(
      page.getByRole("heading", { name: "Metrics", level: 1 }),
    ).toBeVisible();

    const runsStatCard = page
      .locator("div.rounded-lg.border.bg-card")
      .filter({ hasText: "Runs" })
      .first();
    await expect(runsStatCard).toBeVisible();
    const runsValue = Number(
      (await runsStatCard.locator(":scope > div").nth(1).innerText()).replace(
        /,/g,
        "",
      ),
    );
    expect(runsValue).toBeGreaterThan(0);

    const byAgentCard = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "By agent" }),
    });
    const agentLink = byAgentCard.getByRole("link", { name: AGENT_NAME });
    await expect(agentLink).toBeVisible();
    await agentLink.click();

    await page.waitForURL(/\/metrics\/[0-9a-f-]{36}/);

    const capabilitiesCard = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', {
        hasText: "Capabilities",
      }),
    });
    // Anchor by header text: a reordered column would make `td.nth(n)` read the wrong cell.
    const headers = await capabilitiesCard
      .locator("table thead th")
      .allTextContents();
    const callsIndex = headers.findIndex((h) => h.trim() === "Calls");
    const rejectedIndex = headers.findIndex((h) => h.trim() === "Rejected");
    expect(callsIndex).toBeGreaterThanOrEqual(0);
    expect(rejectedIndex).toBeGreaterThanOrEqual(0);

    const numberRow = capabilitiesCard
      .locator("table tbody tr")
      .filter({ hasText: "get_number" });
    await expect(numberRow).toBeVisible();
    const numberCalls = Number(
      await numberRow.locator("td").nth(callsIndex).innerText(),
    );
    expect(numberCalls).toBeGreaterThan(0);

    const cleanupRow = capabilitiesCard
      .locator("table tbody tr")
      .filter({ hasText: "dangerous_cleanup" });
    await expect(cleanupRow).toBeVisible();
    const cleanupCalls = Number(
      await cleanupRow.locator("td").nth(callsIndex).innerText(),
    );
    expect(cleanupCalls).toBeGreaterThan(0);
    const cleanupRejected = Number(
      await cleanupRow.locator("td").nth(rejectedIndex).innerText(),
    );
    expect(cleanupRejected).toBeGreaterThan(0);
  });
});
