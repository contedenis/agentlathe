import { agentSlug } from "@agentlathe/db";
import { expect, test } from "@playwright/test";
import { stackPool } from "./stack-db";

test.describe.configure({ mode: "serial" });

const MODEL = process.env.E2E_MODEL || "~deepseek/deepseek-v4-flash-latest";
const MODEL_TIMEOUT = 90_000;
const STAMP = Date.now();
const AGENT_NAME = `Schedule agent ${STAMP}`;
const SCHEDULE_NAME = `Weekly digest ${STAMP}`;

let scheduleUrl = "";

test.beforeAll(async () => {
  const pool = stackPool();
  try {
    await pool.query(
      `insert into agents (name, slug, model, system_prompt, is_active) values ($1, $2, $3, $4, true)`,
      [
        AGENT_NAME,
        agentSlug(AGENT_NAME),
        MODEL,
        "You are a test agent. Answer in one short sentence.",
      ],
    );
  } finally {
    await pool.end();
  }
});

test.describe("schedules", () => {
  test("creates a weekly schedule through the form, with a preview of its runs", async ({
    page,
  }) => {
    await page.goto("/schedules");
    await expect(
      page.getByRole("heading", { name: "Schedules", level: 1 }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New schedule" }).click();

    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: AGENT_NAME }).click();
    await page.getByLabel("Name").fill(SCHEDULE_NAME);
    await page.getByRole("combobox", { name: "Repeats" }).click();
    await page.getByRole("option", { name: "Weekly" }).click();
    await page.getByRole("combobox", { name: "On" }).click();
    await page.getByRole("option", { name: "Wednesday" }).click();
    await page.getByRole("textbox", { name: "At", exact: true }).fill("07:45");
    await page
      .getByLabel("Message")
      .fill("Today is {{date}}. Reply with exactly: scheduled ok.");

    const preview = page.getByRole("list", { name: "Next runs" });
    await expect(preview.getByRole("listitem")).toHaveCount(5);
    for (const item of await preview.getByRole("listitem").all())
      await expect(item).toHaveText(/^Wed, .*, 07:45$/);

    await page.getByRole("button", { name: "Create" }).click();

    const row = page.getByRole("row", { name: new RegExp(SCHEDULE_NAME) });
    await expect(row).toContainText("Every Wednesday at 07:45");
    await expect(row).toContainText("never ran");
    await expect(row).toContainText("active");

    await row.getByRole("link", { name: SCHEDULE_NAME }).click();
    await page.waitForURL(/\/schedules\/[0-9a-f-]{36}$/);
    scheduleUrl = page.url();
    await expect(page.getByText("It has not come due yet")).toBeVisible();
  });

  test("runs it now: the occurrence succeeds and links to a scheduled run", async ({
    page,
  }) => {
    await page.goto(scheduleUrl);
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(
      page.getByText("Run started.", { exact: false }),
    ).toBeVisible();

    await expect(async () => {
      await page.reload();
      await expect(page.getByText("succeeded")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: MODEL_TIMEOUT });

    await page.getByRole("link", { name: "Open run" }).click();
    await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Run · Scheduled")).toBeVisible();
    await expect(page.getByRole("link", { name: SCHEDULE_NAME })).toBeVisible();
    await expect(page.getByText(/Today is \d{4}-\d{2}-\d{2}\./)).toBeVisible();
  });

  test("the runs list filters scheduled runs", async ({ page }) => {
    await page.goto("/runs?source=schedule");
    await expect(page.getByText(AGENT_NAME).first()).toBeVisible();
  });
});
