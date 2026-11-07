import { getSettings, getSubjectFootprint } from "@agentlathe/db";
import { EmptyState } from "@/components/empty-state";
import { ForgetSubjectButton } from "@/components/forget-subject-button";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { RunsList } from "@/components/runs-list";
import { listRunsPage } from "@/lib/queries";
import { scheduleRetentionSweep } from "@/lib/retention";
import { parseEvaluationFilter } from "@/lib/run-evaluation-filter";
import { SOURCE_ORDER } from "@/lib/run-sources";

const PAGE_SIZE = 25;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    source?: string;
    subject?: string;
    evaluation?: string;
    page?: string;
  }>;
}) {
  const { q, source, subject, evaluation, page } = await searchParams;
  const settings = await getSettings();
  scheduleRetentionSweep(settings);
  const query = (q ?? "").trim();
  const activeSubject = (subject ?? "").trim();
  const activeSource = SOURCE_ORDER.some((value) => value === source)
    ? (source as string)
    : "";
  const activeEvaluation = parseEvaluationFilter(evaluation);
  let currentPage = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  let [{ rows, total, needsReviewTotal }, footprint] = await Promise.all([
    listRunsPage({
      q: query,
      source: activeSource || undefined,
      subject: activeSubject || undefined,
      evaluation: activeEvaluation || undefined,
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
    }),
    activeSubject ? getSubjectFootprint(activeSubject) : null,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) {
    currentPage = totalPages;
    ({ rows, total, needsReviewTotal } = await listRunsPage({
      q: query,
      source: activeSource || undefined,
      subject: activeSubject || undefined,
      evaluation: activeEvaluation || undefined,
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
    }));
  }

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow="Workshop · runs"
        title="Runs"
        description="Every call an agent handled, whatever the source. Open one to read its transcript and note fixes."
        action={
          footprint && (
            <ForgetSubjectButton
              subjectId={activeSubject}
              footprint={footprint}
              redirectTo="/runs"
            />
          )
        }
      />
      {total === 0 &&
      !query &&
      !activeSource &&
      !activeSubject &&
      !activeEvaluation ? (
        <EmptyState
          title="No runs yet"
          description="A run is recorded whenever an agent answers — from the Playground, the API or MCP."
        />
      ) : (
        <RunsList
          runs={rows}
          total={total}
          query={query}
          source={activeSource}
          subject={activeSubject}
          evaluation={activeEvaluation}
          needsReviewTotal={needsReviewTotal}
          page={currentPage}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  );
}
