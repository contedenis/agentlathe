import { expect, test } from "@playwright/test";
import { makePdf } from "../pdf-fixture";
import { APP_PORT } from "./port.mjs";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";
const MODEL_TIMEOUT = 90_000;
const BASE_URL = `http://localhost:${APP_PORT}`;
const STAMP = Date.now();

const SEARCHED_POLICY = `# Equipment policy

## Lost equipment

Report a lost laptop to the service desk within four hours. The code word for the lost laptop procedure is HERON-${STAMP % 1000}.

## Monitors

Each employee can request one external monitor per year.
`;

const ALWAYS_POLICY = `# Office access

The code of the archive room is ORCHID-${STAMP % 1000}. Visitors must sign in at the front desk.
`;

async function query<T>(sql: string, values: unknown[]): Promise<T[]> {
  const pool = stackPool();
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

async function createAgent(
  name: string,
  systemPrompt: string,
  knowledge: { collectionId: string; mode: "search" | "always" }[],
) {
  const response = await fetch(`${BASE_URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      model: MODEL,
      systemPrompt,
      knowledge,
      recordTraffic: true,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
}

async function ask(slug: string, content: string) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function upload(collectionId: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
  return fetch(
    `${BASE_URL}/api/knowledge/collections/${collectionId}/documents`,
    {
      method: "POST",
      body: form,
    },
  );
}

async function waitUntilReady(documentName: string) {
  await expect(async () => {
    const [row] = await query<{ status: string; error: string | null }>(
      "select status, error from knowledge_documents where filename = $1",
      [documentName],
    );
    expect(row?.error ?? null).toBeNull();
    expect(row?.status).toBe("ready");
  }).toPass({ timeout: MODEL_TIMEOUT });
}

test.describe("knowledge", () => {
  test("a document uploaded to a collection is searched by an agent, and the run shows the search", async ({
    page,
  }) => {
    test.setTimeout(MODEL_TIMEOUT * 3);
    await page.goto("/knowledge");
    await page.getByRole("button", { name: "New collection" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(`Equipment ${STAMP}`);
    await dialog
      .getByLabel("Description")
      .fill("Equipment rules: lost laptops, monitors.");
    await dialog.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/knowledge\/[0-9a-f-]{36}$/);
    const collectionId = page.url().split("/").at(-1) as string;

    const documentName = `equipment-${STAMP}.md`;
    await page.getByTestId("knowledge-upload").setInputFiles({
      name: documentName,
      mimeType: "text/markdown",
      buffer: Buffer.from(SEARCHED_POLICY),
    });
    const row = page.getByRole("row", { name: new RegExp(documentName) });
    await expect(row.getByText("ready")).toBeVisible({
      timeout: MODEL_TIMEOUT,
    });

    const agent = await createAgent(
      `Equipment agent ${STAMP}`,
      "You answer questions about company equipment policy. Always call search_knowledge before answering, then answer in one short sentence.",
      [{ collectionId, mode: "search" }],
    );
    const answer = await ask(
      agent.slug,
      "What is the code word for the lost laptop procedure?",
    );
    expect(answer).toContain(`HERON-${STAMP % 1000}`);

    const [run] = await query<{ id: string }>(
      "select id from agent_runs where agent_id = $1 order by created_at desc limit 1",
      [agent.id],
    );
    const calls = await query<{ kind: string; status: string }>(
      "select kind, status from agent_run_calls where run_id = $1 and name = 'search_knowledge'",
      [run.id],
    );
    expect(calls).toContainEqual({ kind: "knowledge", status: "ok" });

    await page.goto(`/runs/${run.id}`);
    await page.getByText("search_knowledge", { exact: true }).first().click();
    await expect(page.getByText("Searched for").first()).toBeVisible();
    await expect(
      page
        .getByText(new RegExp(`Equipment ${STAMP} · ${documentName}`))
        .first(),
    ).toBeVisible();
  });

  test("an always-read collection reaches the agent without a search", async () => {
    test.setTimeout(MODEL_TIMEOUT * 3);
    const created = await fetch(`${BASE_URL}/api/knowledge/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Office ${STAMP}`, description: "" }),
    });
    expect(created.status).toBe(201);
    const { id: collectionId } = (await created.json()) as { id: string };
    const documentName = `office-${STAMP}.md`;
    expect(
      (
        await upload(
          collectionId,
          documentName,
          new TextEncoder().encode(ALWAYS_POLICY),
        )
      ).status,
    ).toBe(201);
    await waitUntilReady(documentName);

    const agent = await createAgent(
      `Office agent ${STAMP}`,
      "You answer questions about the office using your reference documents. Answer in one short sentence.",
      [{ collectionId, mode: "always" }],
    );
    const answer = await ask(
      agent.slug,
      "What is the code of the archive room?",
    );
    expect(answer).toContain(`ORCHID-${STAMP % 1000}`);

    const calls = await query<{ name: string }>(
      `select c.name from agent_run_calls c join agent_runs r on r.id = c.run_id
        where r.agent_id = $1`,
      [agent.id],
    );
    expect(calls).toEqual([]);
  });

  test("a PDF over 10 MB reaches the app whole through the proxy", async () => {
    const created = await fetch(`${BASE_URL}/api/knowledge/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Large ${STAMP}`, description: "" }),
    });
    const { id: collectionId } = (await created.json()) as { id: string };
    const pdf = makePdf([
      "Large files are uploaded whole: this page is the last bytes of the file.",
    ]);
    const padded = Buffer.concat([
      Buffer.from("%PDF-1.4\n%"),
      Buffer.alloc(12 * 1024 * 1024, 0x20),
      Buffer.from("\n"),
      Buffer.from(pdf.subarray(pdf.indexOf(0x0a) + 1)),
    ]);

    const response = await upload(collectionId, "large.pdf", padded);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { size: number }).size).toBe(
      padded.length,
    );
    const [stored] = await query<{ size: number }>(
      `select octet_length(f.bytes) as size from knowledge_files f
         join knowledge_documents d on d.id = f.document_id
        where d.collection_id = $1`,
      [collectionId],
    );
    expect(stored.size).toBe(padded.length);
  });
});
