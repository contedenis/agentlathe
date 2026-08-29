import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunWorkspace } from "@/components/run-workspace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toFixDrafts } from "@/lib/fix-drafts";
import { getRunForReview } from "@/lib/queries";
import { sourceLabel } from "@/lib/run-sources";
import { toTranscriptMessages } from "@/lib/transcript";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getRunForReview(id);
  if (!run) notFound();

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
          <RunStatusBadge status={run.status} />
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
        </div>
      </div>

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

      <RunWorkspace
        draftsEndpoint={`/api/runs/${id}/fix-drafts`}
        messages={messages}
        initialFixDrafts={drafts}
      />
    </div>
  );
}
