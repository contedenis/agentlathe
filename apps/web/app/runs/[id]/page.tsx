import { renderMemorySection } from "@agentlathe/runner";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { RunMemoryChanges } from "@/components/run-memory-changes";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunWorkspace } from "@/components/run-workspace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { VersionConfigDialog } from "@/components/version-dialogs";
import { toFixDrafts } from "@/lib/fix-drafts";
import { formatInZone } from "@/lib/format";
import { getRunForReview, getRunNeighbors } from "@/lib/queries";
import { getMemoryLoaded, getRunMemoryChanges } from "@/lib/queries-memory";
import { sourceLabel } from "@/lib/run-sources";
import {
  hasRunsFilter,
  parseRunsFilter,
  type RunsFilter,
  runsFilterQuery,
} from "@/lib/runs-filter";
import { toTranscriptMessages } from "@/lib/transcript";
import { readSnapshot } from "@/lib/version-diff";

function QueueLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  const className = "rounded-md border p-1";
  return href ? (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={`${className} text-muted-foreground transition-colors hover:text-foreground`}
    >
      {children}
    </Link>
  ) : (
    <span aria-hidden className={`${className} text-faint opacity-40`}>
      {children}
    </span>
  );
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Partial<Record<keyof RunsFilter, string>>>;
}) {
  const { id } = await params;
  const run = await getRunForReview(id);
  if (!run) notFound();
  const queue = parseRunsFilter(await searchParams);
  const queueQuery = runsFilterQuery(queue);
  const [memoryLoaded, memoryChanges, neighbors] = await Promise.all([
    getMemoryLoaded(run.memorySeen),
    getRunMemoryChanges(run.id),
    getRunNeighbors(run.id, queue),
  ]);
  const memoryStores = memoryLoaded.flatMap((store) =>
    "missing" in store ? [] : [store],
  );
  const memoryMissing = memoryLoaded.length - memoryStores.length;

  const messages = [
    ...toTranscriptMessages(run.input, "in"),
    ...toTranscriptMessages(run.output, "out"),
  ];
  const drafts = toFixDrafts(run.drafts);
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);

  return (
    <div className={LIST_SHELL_CLASS}>
      <BreadcrumbTitle
        name={`${run.agentName} · ${run.createdAt?.toLocaleDateString("en-US") ?? "run"}`}
      />
      <div className="flex flex-col gap-2 lg:shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
              Run · {sourceLabel(run.source)}
            </p>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
              <Link
                href={`/agents/${run.agentId}`}
                className="transition-colors hover:text-primary"
              >
                {run.agentName}
              </Link>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <nav
              aria-label="Runs in this list"
              className="flex items-center gap-1 text-[12px]"
            >
              <Link
                href={`/runs${queueQuery}`}
                className="mr-1 text-muted-foreground hover:text-foreground hover:underline"
              >
                {hasRunsFilter(queue) ? "Filtered runs" : "All runs"}
              </Link>
              <QueueLink
                href={
                  neighbors.newerId && `/runs/${neighbors.newerId}${queueQuery}`
                }
                label="Newer run"
              >
                <ChevronLeftIcon className="size-4" />
              </QueueLink>
              <QueueLink
                href={
                  neighbors.olderId && `/runs/${neighbors.olderId}${queueQuery}`
                }
                label="Older run"
              >
                <ChevronRightIcon className="size-4" />
              </QueueLink>
            </nav>
            <RunStatusBadge status={run.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{run.createdAt?.toLocaleString("en-US") ?? "—"}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">
            {(run.durationMs / 1000).toFixed(1)}s
          </span>
          <span aria-hidden>·</span>
          <span>
            {run.steps} {run.steps === 1 ? "step" : "steps"}
          </span>
          {run.versionHash && (
            <>
              <span aria-hidden>·</span>
              <VersionConfigDialog
                shortHash={run.versionHash.slice(0, 8)}
                config={readSnapshot(run.versionSnapshot)}
              />
            </>
          )}
          {tokens > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">{tokens} tokens</span>
            </>
          )}
          {run.model && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-[12px]">{run.model}</span>
            </>
          )}
          {run.subjectId && (
            <>
              <span aria-hidden>·</span>
              <span>
                Subject{" "}
                <Link
                  href={`/runs?subject=${encodeURIComponent(run.subjectId)}`}
                  className="font-mono text-[12px] text-foreground hover:underline"
                >
                  {run.subjectId}
                </Link>
              </span>
            </>
          )}
        </div>
      </div>

      {run.source === "schedule" && (
        <p className="text-sm text-muted-foreground lg:shrink-0">
          Scheduled
          {run.scheduleId && run.scheduleName ? (
            <>
              {" · "}
              <Link
                href={`/schedules/${run.scheduleId}`}
                className="text-foreground hover:underline"
              >
                {run.scheduleName}
              </Link>
            </>
          ) : (
            " · schedule deleted"
          )}
          {run.scheduledFor &&
            run.scheduleStartedAt &&
            run.scheduleTimezone && (
              <>
                {" · due "}
                <span className="font-mono">
                  {formatInZone(run.scheduledFor, run.scheduleTimezone)}
                </span>
                {", started "}
                <span className="font-mono">
                  {new Intl.DateTimeFormat("en-US", {
                    timeZone: run.scheduleTimezone,
                    timeStyle: "medium",
                    hourCycle: "h23",
                  }).format(run.scheduleStartedAt)}
                </span>
              </>
            )}
        </p>
      )}

      {run.status === "error" && (
        <Alert variant="destructive" className="lg:shrink-0">
          <TriangleAlertIcon />
          <AlertTitle>This run ended with an error</AlertTitle>
          <AlertDescription>
            {run.error ?? "No detail recorded."}
          </AlertDescription>
        </Alert>
      )}

      {(run.mcpFailures?.length ?? 0) > 0 && (
        <Alert className="lg:shrink-0">
          <TriangleAlertIcon />
          <AlertTitle>MCP tools were unavailable</AlertTitle>
          <AlertDescription>
            The agent ran without: {run.mcpFailures?.join(", ")}.
          </AlertDescription>
        </Alert>
      )}

      {(run.warnings?.length ?? 0) > 0 && (
        <Alert className="lg:shrink-0">
          <TriangleAlertIcon />
          <AlertTitle>
            {run.warnings?.length === 1 ? "Warning" : "Warnings"}
          </AlertTitle>
          <AlertDescription>
            <ul>
              {run.warnings?.map((warning) => (
                <li key={warning.message}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {memoryLoaded.length > 0 && (
        <details className="rounded-lg border bg-card p-3 text-sm lg:shrink-0">
          <summary className="cursor-pointer font-medium">
            Memory loaded
            <span className="ml-2 font-normal text-muted-foreground">
              {memoryStores
                .map((store) => `${store.name} rev ${store.revision}`)
                .join(" · ")}
              {memoryMissing > 0 &&
                `${memoryStores.length ? " · " : ""}${memoryMissing} deleted`}
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              What the agent read at the end of its instructions, rebuilt from
              each store's history at the revision the run saw.{" "}
              {memoryStores.map((store, index) => (
                <span key={store.storeId}>
                  {index > 0 && " · "}
                  <Link
                    href={`/memory/${store.storeId}?memory=${encodeURIComponent(store.partitionKey)}`}
                    className="text-foreground hover:underline"
                  >
                    Open {store.name}
                  </Link>
                </span>
              ))}
            </p>
            {memoryStores.length > 0 && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-xs">
                {renderMemorySection(memoryStores)}
              </pre>
            )}
          </div>
        </details>
      )}

      <RunMemoryChanges {...memoryChanges} />

      <RunWorkspace
        agentId={run.agentId}
        runId={id}
        source={run.source}
        draftsEndpoint={`/api/runs/${id}/fix-drafts`}
        messages={messages}
        initialFixDrafts={drafts}
        evaluations={run.evaluations}
        hasActiveCriteria={run.hasActiveCriteria}
        hasTranscript={run.hasTranscript}
      />
    </div>
  );
}
