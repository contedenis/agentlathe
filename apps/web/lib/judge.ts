import { PROVIDER_BASE_URL } from "@agentlathe/runner";

export type JudgeQuestion = {
  instructions: string;
  criteria?: { true: string; false: string };
};

export type JudgeAnswers =
  | { tooLong: true }
  | { tooLong: false; model: string; answers: Record<string, number> };

const TIMEOUT_MS = 20_000;

export function decisionsUrl(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("../alpha/decisions", base).toString();
}

type JudgeEndpoint = {
  url: string;
  apiKey: string | undefined;
  keyVar: "JUDGE_API_KEY" | "PROVIDER_API_KEY";
  custom: boolean;
};

export function judgeEndpoint(): JudgeEndpoint {
  const customUrl = process.env.JUDGE_URL;
  const judgeKey = process.env.JUDGE_API_KEY;
  const usesJudgeKey = Boolean(customUrl || judgeKey);
  return {
    url: customUrl || decisionsUrl(PROVIDER_BASE_URL),
    apiKey: usesJudgeKey ? judgeKey : process.env.PROVIDER_API_KEY,
    keyVar: usesJudgeKey ? "JUDGE_API_KEY" : "PROVIDER_API_KEY",
    custom: Boolean(customUrl),
  };
}

export function judgeHost(): string {
  const { url } = judgeEndpoint();
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorMessageOf(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })
      .error?.message;
    return typeof message === "string" ? message : body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

const TOO_LONG = "max_tokens_exceeded";
const TOO_LONG_PATTERN = /"error_type"\s*:\s*"max_tokens_exceeded"/;

function isTooLong(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { error_type?: unknown };
      error?: { message?: unknown };
    };
    const message = parsed.error?.message;
    return (
      parsed.detail?.error_type === TOO_LONG ||
      (typeof message === "string" && TOO_LONG_PATTERN.test(message))
    );
  } catch {
    return false;
  }
}

export async function askJudge({
  model,
  state,
  questions,
}: {
  model: string;
  state: string;
  questions: Record<string, JudgeQuestion>;
}): Promise<JudgeAnswers> {
  const { url, apiKey, keyVar, custom } = judgeEndpoint();
  if (!apiKey)
    throw new Error(`${keyVar} is not set: the judge cannot be called.`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            { type: "noul", ...question },
          ]),
        ),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      throw new Error(
        `the Decisions API did not answer within ${TIMEOUT_MS / 1000}s`,
      );
    throw new Error(
      `could not reach the Decisions API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = await res.text();
  if (res.status === 404)
    throw new Error(
      custom
        ? `JUDGE_URL does not serve the Decisions API (HTTP 404 from ${judgeHost()})`
        : "the configured provider does not serve the Decisions API; set JUDGE_URL and JUDGE_API_KEY to a Jev endpoint",
    );
  if (res.status === 400 && isTooLong(body)) return { tooLong: true };
  if (res.status === 401 || res.status === 403)
    throw new Error(
      `the Decisions API rejected the API key (HTTP ${res.status}: ${errorMessageOf(body)}); check ${keyVar}`,
    );
  if (!res.ok) {
    const message = errorMessageOf(body);
    const hint = /does not exist/i.test(message)
      ? "; check the judge model in Settings"
      : "";
    throw new Error(
      `the Decisions API returned HTTP ${res.status}: ${message}${hint}`,
    );
  }

  let parsed: { model?: unknown; answers?: Record<string, { noul?: unknown }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("the Decisions API returned a body that is not JSON");
  }
  const answers: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const value = parsed.answers?.[id]?.noul;
    if (value === undefined)
      throw new Error(
        `the Decisions API returned no answer for question ${id}`,
      );
    if (typeof value !== "number" || !(value >= 0 && value <= 1))
      throw new Error(
        `invalid probability from judge for question ${id}: ${JSON.stringify(value)}`,
      );
    answers[id] = value;
  }
  return {
    tooLong: false,
    model: typeof parsed.model === "string" ? parsed.model : model,
    answers,
  };
}
