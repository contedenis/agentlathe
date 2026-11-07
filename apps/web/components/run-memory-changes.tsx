import Link from "next/link";
import type { RunMemoryChanges as Changes } from "@/lib/queries-memory";

const CHANGE_LABEL: Record<string, string> = {
  add: "added",
  update: "edited",
  delete: "deleted",
  restore: "restored",
  compaction: "compacted",
};

const PROPOSAL_LABEL: Record<string, string> = {
  add: "proposed adding",
  update: "proposed editing",
  delete: "proposed deleting",
};

const storeHref = (storeId: string, partitionKey: string) =>
  `/memory/${storeId}?memory=${encodeURIComponent(partitionKey)}`;

export function RunMemoryChanges({ changes, proposals }: Changes) {
  if (changes.length === 0 && proposals.length === 0) return null;
  return (
    <details open className="rounded-lg border bg-card p-3 text-sm lg:shrink-0">
      <summary className="cursor-pointer font-medium">
        Memory changes
        <span className="ml-2 font-normal text-muted-foreground">
          {changes.length + proposals.length} · visible from the next run
        </span>
      </summary>
      <ul aria-label="Memory changes" className="mt-2 flex flex-col gap-1.5">
        {changes.map((change) => (
          <li key={change.id}>
            <Link
              href={storeHref(change.storeId, change.partitionKey)}
              className="text-muted-foreground hover:underline"
            >
              {change.storeName}
            </Link>{" "}
            <span className="font-mono text-xs">[{change.shortId}]</span>{" "}
            {CHANGE_LABEL[change.op] ?? change.op}
            {change.op === "update" && change.before !== null && (
              <span className="text-muted-foreground line-through">
                {" "}
                {change.before}
              </span>
            )}
            {change.op === "delete" ? (
              change.before !== null && (
                <span className="text-muted-foreground"> {change.before}</span>
              )
            ) : (
              <span> {change.content}</span>
            )}
          </li>
        ))}
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <Link
              href={storeHref(proposal.storeId, proposal.partitionKey)}
              className="text-muted-foreground hover:underline"
            >
              {proposal.storeName}
            </Link>{" "}
            {proposal.shortId && (
              <span className="font-mono text-xs">[{proposal.shortId}] </span>
            )}
            {PROPOSAL_LABEL[proposal.op] ?? proposal.op}
            {proposal.content !== null && <span> {proposal.content}</span>}
            <span className="ml-1.5 font-mono text-[11px] text-faint">
              {proposal.status === "pending"
                ? "waiting for approval"
                : (proposal.reason ?? proposal.status)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
