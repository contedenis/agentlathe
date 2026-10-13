import { agentSlug } from "@agentlathe/db";
import { expect, type Page, test } from "@playwright/test";
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
    await expect(page.getByRole("region", { name: "Summary" })).toBeVisible();
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

    const fixDraftsHeader = page.getByRole("tab", { name: /^Fix drafts/ });
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

const EVAL_AGENT_NAME = `Evaluator UI ${STAMP}`;
const EVAL_VERSION_HASH = "c0ffee01";
const Q_LANGUAGE =
  "Did the assistant reply in the same language as the user's last message?";
const Q_FACTS = "Did the assistant avoid inventing facts?";
const PASS_DESCRIPTION = "The reply is written in the user's language.";
const FAIL_DESCRIPTION = "The reply switches to another language.";
const FIX_ANCHOR_MESSAGE_ID = `asst-last-${STAMP}`;

let evalAgentId = "";
let languageCriterionId = "";
let factsCriterionId = "";
let passRunId = "";
let failRunId = "";
let needsReviewRunId = "";
let notApplicableRunId = "";
let overriddenRunId = "";
let notEvaluatedRunId = "";
let noTranscriptRunId = "";

async function stackQuery<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const pool = stackPool();
  try {
    const { rows } = await pool.query(text, values);
    return rows as T[];
  } finally {
    await pool.end();
  }
}

async function reviewedVerdictOf(
  runId: string,
  question: string,
): Promise<string | null> {
  const [row] = await stackQuery<{ reviewed_verdict: string | null }>(
    `select reviewed_verdict from run_evaluations where run_id = $1 and question_snapshot = $2`,
    [runId, question],
  );
  return row?.reviewed_verdict ?? null;
}

async function openEvaluationTab(page: Page, agentId: string) {
  await page.goto(`/agents/${agentId}`);
  await page.getByRole("tab", { name: "Evaluation" }).click();
  await expect(
    page.getByText("New runs are evaluated automatically."),
  ).toBeVisible();
}

function criterionRow(page: Page, question: string) {
  return page
    .getByText(question, { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
}

function evaluationCard(page: Page) {
  return page.getByRole("tabpanel", { name: /^Evaluation/ });
}

function showEvaluation(page: Page) {
  return page.getByRole("tab", { name: /^Evaluation/ }).click();
}

function verdictRow(page: Page, question: string) {
  return evaluationCard(page).locator("li").filter({ hasText: question });
}

function runRow(page: Page, runId: string) {
  return page.locator("main table tbody tr").filter({
    has: page.locator(`a[href="/runs/${runId}"]`),
  });
}

function userMessage(id: string, text: string) {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string) {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

type SeededVerdict = [status: string, reviewed: string | null, pPass: number];

test.describe("evaluators UI", () => {
  test.beforeAll(async () => {
    const pool = stackPool();
    try {
      const agent = await pool.query(
        `insert into agents (name, slug, model, is_active) values ($1, $2, 'test/model', true) returning id`,
        [EVAL_AGENT_NAME, agentSlug(EVAL_AGENT_NAME)],
      );
      evalAgentId = agent.rows[0].id;

      const version = await pool.query(
        `insert into agent_versions (agent_id, hash, snapshot) values ($1, $2, '{}'::jsonb) returning id`,
        [evalAgentId, EVAL_VERSION_HASH],
      );
      const versionId = version.rows[0].id;

      const language = await pool.query(
        `insert into agent_criteria (agent_id, question, pass_description, fail_description)
         values ($1, $2, $3, $4) returning id`,
        [evalAgentId, Q_LANGUAGE, PASS_DESCRIPTION, FAIL_DESCRIPTION],
      );
      languageCriterionId = language.rows[0].id;
      const facts = await pool.query(
        `insert into agent_criteria (agent_id, question) values ($1, $2) returning id`,
        [evalAgentId, Q_FACTS],
      );
      factsCriterionId = facts.rows[0].id;

      async function seedRun(
        input: unknown[] | null,
        output: unknown[] | null,
        verdicts: { language: SeededVerdict; facts: SeededVerdict } | null,
      ): Promise<string> {
        const run = await pool.query(
          `insert into agent_runs (agent_id, agent_version_id, source, status, duration_ms, steps, tool_calls, input_tokens, output_tokens, model)
           values ($1, $2, 'dashboard', 'ok', 900, 1, 0, 60, 30, 'test/model') returning id`,
          [evalAgentId, versionId],
        );
        const runId = run.rows[0].id as string;
        if (input && output)
          await pool.query(
            `insert into run_transcripts (run_id, input, output) values ($1, $2::jsonb, $3::jsonb)`,
            [runId, JSON.stringify(input), JSON.stringify(output)],
          );
        if (verdicts) {
          const entries: [string, string, SeededVerdict][] = [
            [languageCriterionId, Q_LANGUAGE, verdicts.language],
            [factsCriterionId, Q_FACTS, verdicts.facts],
          ];
          for (const [
            criterionId,
            question,
            [status, reviewed, pPass],
          ] of entries)
            await pool.query(
              `insert into run_evaluations (run_id, criterion_id, question_snapshot, p_pass, p_applies, status, judge_model, reviewed_verdict)
               values ($1, $2, $3, $4, $5, $6, 'typesafe/jev-1.13-20260101', $7)`,
              [
                runId,
                criterionId,
                question,
                pPass,
                status === "not_applicable" ? 0.05 : null,
                status,
                reviewed,
              ],
            );
        }
        return runId;
      }

      passRunId = await seedRun(
        [{ role: "user", content: "Hola, ¿cómo estás hoy?" }],
        [{ role: "assistant", content: "Muy bien, gracias por preguntar." }],
        { language: ["pass", null, 0.97], facts: ["pass", null, 0.93] },
      );
      failRunId = await seedRun(
        [
          userMessage("u1", "Dime algo sobre Madrid."),
          assistantMessage("asst-first", "Madrid es la capital de España."),
          userMessage("u2", "Gracias, ¿y sobre Lisboa?"),
        ],
        [
          assistantMessage(
            FIX_ANCHOR_MESSAGE_ID,
            "Lisboa es la capital de Portugal desde 1255.",
          ),
        ],
        { language: ["pass", null, 0.9], facts: ["fail", null, 0.04] },
      );
      needsReviewRunId = await seedRun(
        [{ role: "user", content: "Cuéntame un chiste corto." }],
        [{ role: "assistant", content: "Why did the chicken cross the road?" }],
        { language: ["needs_review", null, 0.5], facts: ["pass", null, 0.9] },
      );
      notApplicableRunId = await seedRun(
        [{ role: "user", content: "42" }],
        [{ role: "assistant", content: "42" }],
        { language: ["not_applicable", null, 0.5], facts: ["pass", null, 0.9] },
      );
      overriddenRunId = await seedRun(
        [{ role: "user", content: "Qual é a capital de França?" }],
        [{ role: "assistant", content: "Paris." }],
        { language: ["fail", "pass", 0.06], facts: ["pass", null, 0.95] },
      );
      notEvaluatedRunId = await seedRun(
        [{ role: "user", content: "¿Qué día es hoy?" }],
        [{ role: "assistant", content: "No tengo acceso a la fecha actual." }],
        null,
      );
      noTranscriptRunId = await seedRun(null, null, null);
    } finally {
      await pool.end();
    }
  });

  test("lists the criteria with their pass rate and toggles one inactive", async ({
    page,
  }) => {
    await openEvaluationTab(page, evalAgentId);

    const language = criterionRow(page, Q_LANGUAGE);
    await expect(language).toContainText("100%");
    await expect(language).toContainText("3 pass · 0 fail");
    await expect(language).toContainText("1 need review");
    await expect(language).toContainText(`Passes when: ${PASS_DESCRIPTION}`);
    await expect(language).toContainText(`Fails when: ${FAIL_DESCRIPTION}`);

    const facts = criterionRow(page, Q_FACTS);
    await expect(facts).toContainText("80%");
    await expect(facts).toContainText("4 pass · 1 fail");
    await expect(facts).not.toContainText("need review");
    await expect(facts.getByText("Inactive", { exact: true })).toHaveCount(0);

    await facts.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("Deactivated.")).toBeVisible();
    await expect(facts.getByText("Inactive", { exact: true })).toBeVisible();
    await expect(facts.getByRole("button", { name: "Activate" })).toBeVisible();

    await openEvaluationTab(page, evalAgentId);
    await expect(
      criterionRow(page, Q_FACTS).getByText("Inactive", { exact: true }),
    ).toBeVisible();
    const [inactive] = await stackQuery(
      `select is_active from agent_criteria where id = $1`,
      [factsCriterionId],
    );
    expect(inactive).toEqual({ is_active: false });

    await criterionRow(page, Q_FACTS)
      .getByRole("button", { name: "Activate" })
      .click();
    await expect(page.getByText("Activated.")).toBeVisible();
    await expect(
      criterionRow(page, Q_FACTS).getByText("Inactive", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const [row] = await stackQuery<{ is_active: boolean }>(
          `select is_active from agent_criteria where id = $1`,
          [factsCriterionId],
        );
        return row.is_active;
      })
      .toBe(true);
  });

  test("creates, edits and deletes a criterion through the dialog", async ({
    page,
  }) => {
    const question = `Did the assistant stay polite? ${STAMP}`;
    const editedQuestion = `Did the assistant stay polite and brief? ${STAMP}`;

    await openEvaluationTab(page, evalAgentId);
    await page.getByRole("button", { name: "Add criterion" }).click();
    const dialog = page.getByRole("dialog", { name: "Add criterion" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Question").fill(question);
    await dialog.getByLabel("Passes when").fill("The tone stays courteous.");
    await dialog.getByLabel("Fails when").fill("The reply is rude or curt.");
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Criterion created.")).toBeVisible();
    await expect(dialog).not.toBeVisible();
    const row = criterionRow(page, question);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Passes when: The tone stays courteous.");
    await expect(row).toContainText("No verdicts in the last 30 days");

    const [created] = await stackQuery(
      `select pass_description, fail_description, source_fix_draft_id, is_active
       from agent_criteria where agent_id = $1 and question = $2`,
      [evalAgentId, question],
    );
    expect(created).toEqual({
      pass_description: "The tone stays courteous.",
      fail_description: "The reply is rude or curt.",
      source_fix_draft_id: null,
      is_active: true,
    });

    await row.getByRole("button", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit criterion" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Question")).toHaveValue(question);
    await editDialog.getByLabel("Question").fill(editedQuestion);
    await editDialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText("Criterion updated.")).toBeVisible();
    await expect(editDialog).not.toBeVisible();
    await expect(criterionRow(page, editedQuestion)).toBeVisible();
    await expect(page.getByText(question, { exact: true })).toHaveCount(0);

    await criterionRow(page, editedQuestion)
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Delete the criterion" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(page.getByText("Deleted the criterion.")).toBeVisible();
    await expect(page.getByText(editedQuestion, { exact: true })).toHaveCount(
      0,
    );
    expect(
      await stackQuery(
        `select id from agent_criteria where agent_id = $1 and question in ($2, $3)`,
        [evalAgentId, question, editedQuestion],
      ),
    ).toHaveLength(0);
  });

  test("filters the runs list by evaluation state", async ({ page }) => {
    await page.goto(`/runs?q=${encodeURIComponent(EVAL_AGENT_NAME)}`);
    const rows = page.locator("main table tbody tr");
    await expect(rows).toHaveCount(7);

    await expect(runRow(page, failRunId)).toContainText("1 fail");
    await expect(runRow(page, needsReviewRunId)).toContainText("1 to review");
    for (const clearRunId of [passRunId, notApplicableRunId, overriddenRunId])
      await expect(
        runRow(page, clearRunId).getByLabel(
          /Every criterion passed|No failures/,
        ),
      ).toBeVisible();
    for (const unjudgedRunId of [notEvaluatedRunId, noTranscriptRunId]) {
      const unjudged = runRow(page, unjudgedRunId);
      await expect(unjudged).not.toContainText("fail");
      await expect(unjudged).not.toContainText("to review");
      await expect(
        unjudged.getByLabel(/Every criterion passed|No failures/),
      ).toHaveCount(0);
    }

    const needsReview = page.getByRole("button", { name: /^Needs review/ });
    await expect(needsReview).toContainText("1");
    await needsReview.click();
    await page.waitForURL(/evaluation=needs_review/);
    await expect(rows).toHaveCount(1);
    await expect(runRow(page, needsReviewRunId)).toContainText("1 to review");
    await expect(page.getByText("1 result", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Failed" }).click();
    await page.waitForURL(/evaluation=failed/);
    await expect(rows).toHaveCount(1);
    await expect(runRow(page, failRunId)).toContainText("1 fail");
    await expect(runRow(page, overriddenRunId)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Needs review/ }),
    ).toContainText("1");

    await page.getByRole("button", { name: "Not evaluated" }).click();
    await page.waitForURL(/evaluation=not_evaluated/);
    await expect(rows).toHaveCount(1);
    await expect(runRow(page, notEvaluatedRunId)).toBeVisible();
    await expect(runRow(page, noTranscriptRunId)).toHaveCount(0);

    await page.getByRole("button", { name: "All", exact: true }).last().click();
    await page.waitForURL((url) => !url.searchParams.has("evaluation"));
    await expect(rows).toHaveCount(7);
  });

  test("reviews verdicts and notes a fix from the run's Evaluation tab", async ({
    page,
  }) => {
    await page.goto(`/runs/${failRunId}`);
    await expect(evaluationCard(page)).toBeVisible();
    const items = evaluationCard(page).locator("li");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(Q_FACTS);
    await expect(items.nth(0)).toContainText("Fail");
    await expect(items.nth(1)).toContainText(Q_LANGUAGE);
    await expect(items.nth(1)).toContainText("Pass");

    await verdictRow(page, Q_FACTS)
      .getByTitle("Note a fix: last assistant turn")
      .click();
    const noteDialog = page.getByRole("dialog", { name: "Note a fix" });
    await expect(noteDialog).toBeVisible();
    await expect(noteDialog.getByLabel("Rationale")).toHaveValue(
      `Failed criterion: ${Q_FACTS}`,
    );
    await noteDialog.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Note saved.")).toBeVisible();
    await expect(noteDialog).not.toBeVisible();

    await expect(
      page.getByRole("heading", { name: "System prompt (1)" }),
    ).toBeVisible();
    await expect(
      page.getByText(`Failed criterion: ${Q_FACTS}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Assistant turn" }),
    ).toBeVisible();
    const [draft] = await stackQuery(
      `select message_id, anchor, rationale, status from fix_drafts where run_id = $1`,
      [failRunId],
    );
    expect(draft).toEqual({
      message_id: FIX_ANCHOR_MESSAGE_ID,
      anchor: { type: "turn" },
      rationale: `Failed criterion: ${Q_FACTS}`,
      status: "open",
    });

    await showEvaluation(page);
    await verdictRow(page, Q_FACTS)
      .getByRole("button", { name: "Pass", exact: true })
      .click();
    await expect(verdictRow(page, Q_FACTS)).toContainText(/judge said Fail/);
    await expect(
      verdictRow(page, Q_FACTS).getByRole("button", { name: "Undo" }),
    ).toBeVisible();
    await expect(
      verdictRow(page, Q_FACTS).getByTitle("Note a fix: last assistant turn"),
    ).toHaveCount(0);
    await expect.poll(() => reviewedVerdictOf(failRunId, Q_FACTS)).toBe("pass");

    await page.reload();
    await showEvaluation(page);
    await expect(verdictRow(page, Q_FACTS)).toContainText(/judge said Fail/);
    await verdictRow(page, Q_FACTS)
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(verdictRow(page, Q_FACTS)).not.toContainText(
      /judge said Fail/,
    );
    await expect(
      verdictRow(page, Q_FACTS).getByTitle("Note a fix: last assistant turn"),
    ).toBeVisible();
    await expect.poll(() => reviewedVerdictOf(failRunId, Q_FACTS)).toBeNull();

    await page.goto(`/runs/${needsReviewRunId}`);
    await expect(verdictRow(page, Q_LANGUAGE)).toContainText("Needs review");
    await verdictRow(page, Q_LANGUAGE)
      .getByTitle("Note a fix: last assistant turn")
      .click();
    const unsureDialog = page.getByRole("dialog", { name: "Note a fix" });
    await expect(unsureDialog.getByLabel("Rationale")).toHaveValue(
      /^(Judge unsure on|Failed) criterion: /,
    );
    await unsureDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(unsureDialog).not.toBeVisible();

    await verdictRow(page, Q_LANGUAGE)
      .getByRole("button", { name: "Fail", exact: true })
      .click();
    await expect(
      verdictRow(page, Q_LANGUAGE).getByRole("button", { name: "Undo" }),
    ).toBeVisible();
    await expect(verdictRow(page, Q_LANGUAGE)).toContainText(/Fail/);
    await expect(verdictRow(page, Q_LANGUAGE)).toContainText(/Reviewed/);
    await expect(
      verdictRow(page, Q_LANGUAGE).locator("span").first(),
    ).toHaveText("Fail");
    await expect
      .poll(() => reviewedVerdictOf(needsReviewRunId, Q_LANGUAGE))
      .toBe("fail");

    await page.reload();
    await expect(
      verdictRow(page, Q_LANGUAGE).getByRole("button", { name: "Undo" }),
    ).toBeVisible();
    await expect(verdictRow(page, Q_LANGUAGE)).toContainText(/Reviewed/);
    await verdictRow(page, Q_LANGUAGE)
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(
      verdictRow(page, Q_LANGUAGE).getByRole("button", { name: "Undo" }),
    ).toHaveCount(0);
    await expect(verdictRow(page, Q_LANGUAGE)).toContainText("Needs review");
    await expect
      .poll(() => reviewedVerdictOf(needsReviewRunId, Q_LANGUAGE))
      .toBeNull();
  });

  test("shows the evaluation metrics for the agent and across agents", async ({
    page,
  }) => {
    await page.goto(`/metrics/${evalAgentId}`);
    const card = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', {
        hasText: "Evaluation by agent version",
      }),
    });
    await expect(card).toBeVisible();
    await expect(card.locator("table thead")).toContainText(EVAL_VERSION_HASH);
    await expect(card.locator("table thead")).toContainText("newest");

    const languageRow = card
      .locator("table tbody tr")
      .filter({ hasText: Q_LANGUAGE });
    await expect(languageRow).toContainText("100%");
    await expect(languageRow).toContainText("n=3");
    await expect(languageRow).toContainText("1 to review");
    const factsRow = card
      .locator("table tbody tr")
      .filter({ hasText: Q_FACTS });
    await expect(factsRow).toContainText("80%");
    await expect(factsRow).toContainText("n=5");

    const agreement = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', {
        hasText: "Judge vs human",
      }),
    });
    await expect(agreement).toContainText("Not enough reviews yet");
    await expect(agreement).toContainText("1 of 5 reviewed verdicts needed.");

    await page.goto("/metrics");
    const [totals] = await stackQuery<{
      pass: number;
      fail: number;
      awaiting_runs: number;
    }>(
      `select
         (count(*) filter (where coalesce(e.reviewed_verdict, e.status) = 'pass'))::int as pass,
         (count(*) filter (where coalesce(e.reviewed_verdict, e.status) = 'fail'))::int as fail,
         (count(distinct e.run_id) filter (where e.status = 'needs_review' and e.reviewed_verdict is null))::int as awaiting_runs
       from run_evaluations e
       join agent_criteria c on c.id = e.criterion_id
       where c.is_active and e.question_snapshot = c.question`,
    );
    const expectedRate = Math.round(
      (totals.pass / (totals.pass + totals.fail)) * 100,
    );
    expect(totals.awaiting_runs).toBeGreaterThanOrEqual(1);

    const passRateStat = page
      .locator("div.rounded-lg.border.bg-card")
      .filter({ hasText: "Evaluation pass rate" })
      .first();
    await expect(passRateStat).toContainText(`${expectedRate}%`);
    await expect(passRateStat).toContainText(
      `${totals.pass + totals.fail} judged verdicts across agents`,
    );
    const awaiting = page
      .locator("div.rounded-lg.border.bg-card")
      .filter({ hasText: /awaiting review/i })
      .first();
    await expect(awaiting).toContainText(String(totals.awaiting_runs));

    const byAgentCard = page.locator('[data-slot="card"]').filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "By agent" }),
    });
    const agentRow = byAgentCard
      .locator("tr")
      .filter({ has: page.getByRole("link", { name: EVAL_AGENT_NAME }) });
    await expect(agentRow).toContainText("88%");
    await expect(agentRow).toContainText("n=8");

    await awaiting.locator('a[href="/runs?evaluation=needs_review"]').click();
    await page.waitForURL(/\/runs\?evaluation=needs_review/);
    await expect(
      page.getByRole("button", { name: /^Needs review/ }),
    ).toBeVisible();
    await expect(
      page.locator(`a[href="/runs/${needsReviewRunId}"]`),
    ).toBeVisible();
  });
});
