import { getSettings } from "@agentlathe/db";
import { EmptyState } from "@/components/empty-state";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { RunsList } from "@/components/runs-list";
import { listRunsPage } from "@/lib/queries";
import { scheduleRetentionSweep } from "@/lib/retention";
import { SOURCE_ORDER } from "@/lib/run-sources";

const PAGE_SIZE = 25;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string; page?: string }>;
}) {
  const { q, source, page } = await searchParams;
  const settings = await getSettings();
  scheduleRetentionSweep(settings);
  const query = (q ?? "").trim();
  const activeSource = SOURCE_ORDER.some((value) => value === source)
    ? (source as string)
    : "";
  let currentPage = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);

  let { rows, total } = await listRunsPage({
    q: query,
    source: activeSource || undefined,
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) {
    currentPage = totalPages;
    ({ rows, total } = await listRunsPage({
      q: query,
      source: activeSource || undefined,
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
      />
      {total === 0 && !query && !activeSource ? (
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
          page={currentPage}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  );
}
