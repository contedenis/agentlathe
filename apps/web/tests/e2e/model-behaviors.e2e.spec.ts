import { expect, test } from "@playwright/test";
import { APP_PORT } from "./port.mjs";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";
const MODEL_TIMEOUT = 60_000;
const BASE_URL = `http://localhost:${APP_PORT}`;

async function createAgent(body: {
  name: string;
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  toolIds?: string[];
  subAgentIds?: string[];
}): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `failed to create agent: ${response.status} ${await response.text()}`,
    );
  }
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function getNumberToolId(): Promise<string> {
  const pool = stackPool();
  try {
    const result = await pool.query<{ id: string }>(
      "select id from tools where name = 'get_number'",
    );
    return result.rows[0].id;
  } finally {
    await pool.end();
  }
}

// Set by "multi-turn keeps the thread", consumed by "sub-agent delegation": a fresh
// agent-with-a-prior-run would duplicate that setup. `--grep` on one test fails here.
let threadAgentId = "";

test.describe("model behaviors", () => {
  test("model failure surfaces and is recorded", async ({ page }) => {
    const agentId = await createAgent({
      name: `E2E Failure Agent ${Date.now()}`,
      model: "openrouter/does-not-exist-e2e",
    });

    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    await input.fill("hola");
    await input.press("Enter");

    await expect(
      page.getByRole("alert").filter({ hasText: "Error" }),
    ).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });

    const pool = stackPool();
    try {
      const result = await pool.query<{ status: string }>(
        "select status from agent_runs where agent_id = $1 order by created_at desc limit 1",
        [agentId],
      );
      expect(result.rows[0]?.status).toBe("error");
    } finally {
      await pool.end();
    }
  });

  test("stop mid-stream leaves the app usable", async ({ page }) => {
    const toolId = await getNumberToolId();
    const agentId = await createAgent({
      name: `E2E Stop Agent ${Date.now()}`,
      model: MODEL,
      systemPrompt:
        "You are a verbose assistant. Whatever you are asked, answer with a very long, detailed, multi-paragraph response of at least 500 words before concluding.",
      toolIds: [toolId],
    });

    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    const message = "Write a very long essay about the history of numbers.";
    await input.fill(message);
    await input.press("Enter");

    const stopButton = page.getByRole("button", { name: "Stop" });
    await expect(stopButton).toBeVisible({ timeout: MODEL_TIMEOUT });
    await stopButton.click();

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });
    await expect(
      page.getByRole("alert").filter({ hasText: "Error" }),
    ).toHaveCount(0);
    await expect(page.locator('[role="log"] .is-user').last()).toContainText(
      message,
    );
  });

  test("multi-turn keeps the thread", async ({ page }) => {
    const toolId = await getNumberToolId();
    const agentId = await createAgent({
      name: `E2E Thread Agent ${Date.now()}`,
      model: MODEL,
      systemPrompt:
        "You are a test agent. When asked for the number, you MUST call the get_number tool and answer including its numeric result.",
      toolIds: [toolId],
    });
    threadAgentId = agentId;

    await page.goto(`/agents/${agentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });

    await input.fill("What is the number right now? Use your tool.");
    await input.press("Enter");

    await expect(
      page.locator('[role="log"] .is-assistant').last(),
    ).toContainText(/7/, { timeout: MODEL_TIMEOUT });
    await expect(page.getByRole("link", { name: "Open run" })).toHaveCount(1, {
      timeout: MODEL_TIMEOUT,
    });

    await input.fill("Say the number again, nothing else.");
    await input.press("Enter");

    await expect(page.getByRole("link", { name: "Open run" })).toHaveCount(2, {
      timeout: MODEL_TIMEOUT,
    });

    const pool = stackPool();
    try {
      const result = await pool.query<{ thread_id: string | null }>(
        "select thread_id from agent_runs where agent_id = $1 and source = 'dashboard' order by created_at asc",
        [agentId],
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
      const threadIds = result.rows.map((row) => row.thread_id);
      expect(threadIds[0]).not.toBeNull();
      expect(new Set(threadIds).size).toBe(1);
    } finally {
      await pool.end();
    }
  });

  test("sub-agent delegation end to end", async ({ page }) => {
    // Depends on "multi-turn keeps the thread" having run; see `threadAgentId` above.
    const childId = threadAgentId;
    expect(childId).toMatch(/^[0-9a-f-]{36}$/);
    const parentId = await createAgent({
      name: `E2E Parent Agent ${Date.now()}`,
      model: MODEL,
      systemPrompt:
        "You cannot answer number questions yourself. You MUST delegate them to your sub-agent tool and repeat its answer.",
      subAgentIds: [childId],
    });

    await page.goto(`/agents/${parentId}`);

    const input = page.getByRole("textbox", {
      name: "Write a message (Enter sends, Shift+Enter adds a line break)",
    });
    await input.fill("What is the number? Ask your sub-agent.");
    await input.press("Enter");

    await expect(page.getByRole("link", { name: "Open run" })).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });

    const subAgentToolButton = page.getByRole("button", {
      name: /subagent_/,
    });
    await expect(subAgentToolButton.first()).toBeVisible();

    const pool = stackPool();
    try {
      const runResult = await pool.query<{ id: string }>(
        `select id from agent_runs where agent_id = $1 and source = 'dashboard'
         order by created_at desc limit 1`,
        [parentId],
      );
      const runId = runResult.rows[0]?.id;
      expect(runId).toBeTruthy();

      const callResult = await pool.query<{ kind: string; status: string }>(
        "select kind, status from agent_run_calls where run_id = $1 and kind = 'sub_agent'",
        [runId],
      );
      expect(callResult.rows.length).toBeGreaterThan(0);
      expect(callResult.rows[0]?.status).toBe("ok");
    } finally {
      await pool.end();
    }
  });
});
