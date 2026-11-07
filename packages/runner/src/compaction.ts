import { MEMORY_ENTRY_MAX_LENGTH } from "@agentlathe/db";
import { generateText, Output } from "ai";
import { z } from "zod";
import { buildProvider } from "./helpers";

export type CompactionEntry = {
  shortId: string;
  content: string;
  pinned: boolean;
  updatedAt: Date;
};

export const compactionSchema = z.object({
  operations: z.array(
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("keep"), id: z.string() }),
      z.object({
        op: z.literal("merge"),
        ids: z.array(z.string()).min(1),
        content: z.string(),
      }),
      z.object({ op: z.literal("delete"), id: z.string(), reason: z.string() }),
    ]),
  ),
});

export type CompactionPlan = z.infer<typeof compactionSchema>;

export class CompactionError extends Error {
  constructor(
    message: string,
    readonly inputTokens: number,
    readonly outputTokens: number,
  ) {
    super(message);
  }
}

export function checkCompaction(
  plan: CompactionPlan,
  entries: CompactionEntry[],
  target: number,
): { plan: CompactionPlan; chars: number } {
  const byId = new Map(entries.map((entry) => [entry.shortId, entry]));
  const seen = new Set<string>();
  const claim = (id: string, op: string) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Entry ${id} does not exist.`);
    if (seen.has(id)) throw new Error(`Entry ${id} appears more than once.`);
    if (entry.pinned && op !== "keep")
      throw new Error(`Entry ${id} is pinned and must be kept as it is.`);
    seen.add(id);
    return entry;
  };

  let chars = 0;
  const operations = plan.operations.map((operation) => {
    if (operation.op === "keep") {
      chars += claim(operation.id, "keep").content.length;
      return operation;
    }
    if (operation.op === "delete") {
      claim(operation.id, "delete");
      return operation;
    }
    for (const id of operation.ids) claim(id, "merge");
    const content = operation.content.replace(/\s+/g, " ").trim();
    if (!content) throw new Error(`The merge of ${operation.ids} is empty.`);
    if (content.length > MEMORY_ENTRY_MAX_LENGTH)
      throw new Error(
        `The merge of ${operation.ids} has ${content.length} characters; an entry holds at most ${MEMORY_ENTRY_MAX_LENGTH}.`,
      );
    chars += content.length;
    return { ...operation, content };
  });

  const missing = entries.filter((entry) => !seen.has(entry.shortId));
  if (missing.length > 0)
    throw new Error(
      `Every entry needs an operation; missing: ${missing.map((entry) => entry.shortId).join(", ")}.`,
    );
  if (chars > target)
    throw new Error(
      `The result has ${chars} characters; it must fit in ${target}.`,
    );
  return { plan: { operations }, chars };
}

export function compactionPrompt({
  purpose,
  entries,
  target,
}: {
  purpose: string;
  entries: CompactionEntry[];
  target: number;
}): string {
  const used = entries.reduce((sum, entry) => sum + entry.content.length, 0);
  const lines = entries.map(
    (entry) =>
      `- [${entry.shortId}]${entry.pinned ? " PINNED" : ""} (${entry.updatedAt.toISOString().slice(0, 10)}) ${entry.content.replace(/\s+/g, " ").trim()}`,
  );
  return [
    `Consolidate this memory to at most ${target} characters. Merge duplicates and related facts into one entry; when two entries conflict, keep the newer one; drop entries that are obsolete or superseded. Keep specifics exactly: names, numbers, dates, ids. Never invent, generalize away or change the meaning of a fact. Never modify or drop pinned entries. Respect the store's purpose: drop entries that do not belong to it.`,
    `Purpose of this memory: ${purpose.replace(/\s+/g, " ").trim()}`,
    `Entries, ${used} characters now (id, date, text):\n${lines.join("\n")}`,
    'Answer with JSON only, in this shape: {"operations":[{"op":"keep","id":"a1"},{"op":"merge","ids":["a2","a3"],"content":"the merged fact"},{"op":"delete","id":"a4","reason":"why it goes"}]}. Every entry id appears in exactly one operation; pinned entries are always "keep". A merge with a single id rewrites that entry. Each entry holds at most ' +
      `${MEMORY_ENTRY_MAX_LENGTH} characters.`,
  ].join("\n\n");
}

export async function planCompaction({
  model,
  purpose,
  entries,
  target,
  abortSignal,
}: {
  model: string;
  purpose: string;
  entries: CompactionEntry[];
  target: number;
  abortSignal?: AbortSignal;
}): Promise<{
  plan: CompactionPlan;
  chars: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const prompt = compactionPrompt({ purpose, entries, target });
  let inputTokens = 0;
  let outputTokens = 0;
  let rejection: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: buildProvider(model),
        output: Output.object({ schema: compactionSchema }),
        prompt: rejection
          ? `${prompt}\n\nYour previous answer was rejected: ${rejection} Answer again.`
          : prompt,
        abortSignal,
      });
      inputTokens += result.totalUsage.inputTokens ?? 0;
      outputTokens += result.totalUsage.outputTokens ?? 0;
      return {
        ...checkCompaction(result.output, entries, target),
        inputTokens,
        outputTokens,
      };
    } catch (err) {
      const usage = (
        err as { usage?: { inputTokens?: number; outputTokens?: number } }
      ).usage;
      inputTokens += usage?.inputTokens ?? 0;
      outputTokens += usage?.outputTokens ?? 0;
      rejection = err instanceof Error ? err.message : String(err);
    }
  }
  throw new CompactionError(
    `The compaction failed twice: ${rejection}`,
    inputTokens,
    outputTokens,
  );
}
