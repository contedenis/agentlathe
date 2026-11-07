import { expect, test } from "@playwright/test";
import { APP_PORT } from "./port.mjs";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";
const MODEL_TIMEOUT = 90_000;
const BASE_URL = `http://localhost:${APP_PORT}`;
const STAMP = Date.now();
const AGENT_NAME = `Memory agent ${STAMP}`;
const SUBJECT = `e2e-customer-${STAMP}`;

let agentId = "";
let slug = "";

async function ask(content: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: slug,
      messages: [{ role: "user", content }],
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return body.choices[0].message.content;
}

async function query<T>(sql: string, values: unknown[]): Promise<T[]> {
  const pool = stackPool();
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

test.beforeAll(async () => {
  const response = await fetch(`${BASE_URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: AGENT_NAME,
      model: MODEL,
      systemPrompt:
        "You are a support agent. When the customer tells you a fact about themselves, save it with memory_add before you answer. Answer in one short sentence.",
      memory: {
        type: "agent_subject",
        settings: {
          purpose: "Facts each customer told you about themselves.",
          charLimit: 8000,
          requireApproval: false,
        },
      },
    }),
  });
  expect(response.status).toBe(201);
  ({ id: agentId, slug } = (await response.json()) as {
    id: string;
    slug: string;
  });
});

test.describe("memory", () => {
  test("what one run saves for a subject, the next run for that subject reads", async ({
    page,
  }) => {
    test.setTimeout(MODEL_TIMEOUT * 3);
    await ask("My favorite color is teal. Please remember it.", {
      "x-subject-id": SUBJECT,
    });

    await expect(async () => {
      const rows = await query<{ content: string }>(
        `select v.content from memory_entry_versions v
           join memory_entries e on e.id = v.entry_id
           join memory_stores s on s.id = e.store_id
          where s.owner_agent_id = $1 and e.partition_key = $2`,
        [agentId, SUBJECT],
      );
      expect(rows.map((row) => row.content).join(" ")).toMatch(/teal/i);
    }).toPass({ timeout: MODEL_TIMEOUT });

    const answer = await ask(
      "What is my favorite color? Answer with the color only.",
      { "x-subject-id": SUBJECT },
    );
    expect(answer).toMatch(/teal/i);

    const [run] = await query<{ id: string }>(
      "select id from agent_runs where agent_id = $1 and subject_id = $2 order by created_at desc limit 1",
      [agentId, SUBJECT],
    );
    await page.goto(`/runs/${run.id}`);
    await page.getByText("Memory loaded").click();
    await expect(page.getByText(/teal/i).first()).toBeVisible();
  });

  test("a run without x-subject-id runs without the memory and says so", async ({
    page,
  }) => {
    await ask("Hello.");
    const [run] = await query<{ id: string }>(
      "select id from agent_runs where agent_id = $1 and subject_id is null order by created_at desc limit 1",
      [agentId],
    );
    await page.goto(`/runs/${run.id}`);
    await expect(
      page.getByText(/Ran without the memory .*no x-subject-id was sent\./),
    ).toBeVisible();
    await expect(page.getByText("Memory loaded")).toHaveCount(0);
  });

  test("forgetting the subject deletes its memory and unlinks its runs", async ({
    page,
  }) => {
    await page.goto(`/runs?subject=${SUBJECT}`);
    await page.getByRole("button", { name: "Forget subject" }).click();
    await expect(page.getByText(/Its memory in 1 agent/)).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Forget subject" })
      .click();
    await page.waitForURL(/\/runs$/);

    expect(
      await query(
        "select 1 from memory_partitions where partition_key = $1 union all select 1 from agent_runs where subject_id = $1",
        [SUBJECT],
      ),
    ).toEqual([]);
  });
});
