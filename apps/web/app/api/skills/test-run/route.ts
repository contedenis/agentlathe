import {
  fallbackContextLimit,
  runScript,
  ScriptError,
  toolResultLimit,
} from "@agentlathe/runner";
import { z } from "zod";
import { parseBody } from "@/lib/api-helpers";
import { SKILL_SCRIPT_MAX_LENGTH } from "../schema";

const testRunSchema = z.object({
  script: z.string().min(1).max(SKILL_SCRIPT_MAX_LENGTH),
  input: z.unknown(),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, testRunSchema);
  if ("error" in parsed) return parsed.error;

  const startedAt = Date.now();
  try {
    const { result, logs } = await runScript({
      script: parsed.data.script,
      input: parsed.data.input ?? {},
      resultLimit: toolResultLimit(fallbackContextLimit()),
      abortSignal: req.signal,
    });
    return Response.json({
      ok: true,
      result,
      logs: logs ?? [],
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (!(err instanceof ScriptError)) throw err;
    return Response.json({
      ok: false,
      error: err.reason,
      logs: err.logs,
      durationMs: Date.now() - startedAt,
    });
  }
}
