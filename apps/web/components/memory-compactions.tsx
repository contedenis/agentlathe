import { Badge } from "@/components/ui/badge";
import type { CompactionDetail } from "@/lib/memory-compaction";

export type CompactionView = {
  id: string;
  status: string;
  model: string;
  fromRevision: number;
  toRevision: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  operations: unknown;
  error: string | null;
  createdAt: Date;
};

const STALE_RUNNING_MS = 10 * 60 * 1000;

const when = (date: Date) =>
  new Date(date).toISOString().slice(0, 16).replace("T", " ");

function Operations({ detail }: { detail: CompactionDetail }) {
  const changed = detail.operations.filter((op) => op.op !== "keep");
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-xs">
      {changed.length === 0 && (
        <li className="text-muted-foreground">Every entry kept as it was.</li>
      )}
      {changed.map((operation) =>
        operation.op === "merge" ? (
          <li key={operation.ids.join(",")}>
            <span className="font-mono">[{operation.ids.join(", ")}]</span>{" "}
            {operation.ids.length > 1 ? "merged into" : "rewritten as"}{" "}
            {operation.content}
          </li>
        ) : operation.op === "delete" ? (
          <li key={operation.id}>
            <span className="font-mono">[{operation.id}]</span> dropped:{" "}
            <span className="text-muted-foreground">{operation.reason}</span>
          </li>
        ) : null,
      )}
    </ul>
  );
}

export function MemoryCompactions({
  compactions,
  pinnedChars,
  target,
}: {
  compactions: CompactionView[];
  pinnedChars: number;
  target: number;
}) {
  return (
    <section aria-label="Compactions" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Compactions</h3>
      {pinnedChars > target && (
        <p className="text-xs text-destructive">
          Pinned entries take {pinnedChars.toLocaleString("en-US")} characters,
          more than the {target.toLocaleString("en-US")} a compaction keeps, so
          this memory is not compacted. Unpin some entries or raise the limit.
        </p>
      )}
      {compactions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. A memory is compacted when it passes 90% of its limit; a
          deleted or merged entry can be restored from its history.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {compactions.map((compaction) => {
            const detail = compaction.operations as CompactionDetail | null;
            const interrupted =
              compaction.status === "running" &&
              Date.now() - new Date(compaction.createdAt).getTime() >
                STALE_RUNNING_MS;
            return (
              <li key={compaction.id} className="rounded-lg border p-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      compaction.status === "failed"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {interrupted ? "interrupted" : compaction.status}
                  </Badge>
                  <span className="font-mono text-[11px] text-faint">
                    {when(compaction.createdAt)} · {compaction.model}
                    {compaction.inputTokens !== null &&
                      ` · ${(compaction.inputTokens ?? 0) + (compaction.outputTokens ?? 0)} tokens`}
                    {detail &&
                      ` · ${detail.beforeChars.toLocaleString("en-US")} → ${detail.afterChars.toLocaleString("en-US")} characters`}
                    {compaction.toRevision !== null &&
                      ` · rev ${compaction.fromRevision} → ${compaction.toRevision}`}
                  </span>
                </p>
                {compaction.error && (
                  <p className="mt-1 text-xs text-destructive">
                    {compaction.error}
                  </p>
                )}
                {detail && <Operations detail={detail} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
