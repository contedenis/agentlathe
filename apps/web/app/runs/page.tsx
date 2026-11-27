import { getSettings, getSubjectFootprint } from "@agentlathe/db";
import { EmptyState } from "@/components/empty-state";
import { ForgetSubjectButton } from "@/components/forget-subject-button";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { RunsList } from "@/components/runs-list";
import { getAgentName, listRunsPage } from "@/lib/queries";
import { scheduleRetentionSweep } from "@/lib/retention";
import {
  hasRunsFilter,
  parseRunsFilter,
  type RunsFilter,
} from "@/lib/runs-filter";

const PAGE_SIZE = 25;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<
    Partial<Record<keyof RunsFilter, string>> & { page?: string }
  >;
}) {
  const { page, ...params } = await searchParams;
  const settings = await getSettings();
  scheduleRetentionSweep(settings);
  const filter = parseRunsFilter(params);
  let currentPage = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  let [{ rows, total, needsReviewTotal }, footprint, agentName] =
    await Promise.all([
      listRunsPage({
        ...filter,
        limit: PAGE_SIZE,
        offset: (currentPage - 1) * PAGE_SIZE,
      }),
      filter.subject ? getSubjectFootprint(filter.subject) : null,
      filter.agent ? getAgentName(filter.agent) : null,
    ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) {
    currentPage = totalPages;
    ({ rows, total, needsReviewTotal } = await listRunsPage({
      ...filter,
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
              subjectId={filter.subject}
              footprint={footprint}
              redirectTo="/runs"
            />
          )
        }
      />
      {total === 0 && !hasRunsFilter(filter) ? (
        <EmptyState
          title="No runs yet"
          description="A run is recorded whenever an agent answers — from the Playground, the API or MCP."
        />
      ) : (
        <RunsList
          runs={rows}
          total={total}
          filter={filter}
          agentName={agentName}
          needsReviewTotal={needsReviewTotal}
          page={currentPage}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  );
}
