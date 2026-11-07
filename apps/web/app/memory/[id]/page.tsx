import { getSubjectFootprint } from "@agentlathe/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import { ForgetSubjectButton } from "@/components/forget-subject-button";
import { LIST_TABLE_CLASS } from "@/components/list-search";
import { MemoryCompactions } from "@/components/memory-compactions";
import {
  AddMemoryEntryButton,
  MemoryEntriesTable,
  MemoryProposals,
} from "@/components/memory-entries";
import { MEMORY_DELETE_DESCRIPTION } from "@/components/memory-stores-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { compactionTarget, listCompactions } from "@/lib/memory-compaction";
import {
  MEMORY_SCOPE_DESCRIPTION,
  MEMORY_SCOPE_LABEL,
} from "@/lib/memory-rules";
import { getMemoryStore, getPartitionEntries } from "@/lib/queries-memory";
import { cn } from "@/lib/utils";

const PARTITION_HEADING = {
  agent: "Agent",
  agent_subject: "Subject",
  custom: "Key",
} as const;

export default async function MemoryStorePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ memory?: string }>;
}) {
  const [{ id }, { memory }] = await Promise.all([params, searchParams]);
  const store = await getMemoryStore(id);
  if (!store) notFound();

  const selected =
    store.partitions.find((partition) => partition.partitionKey === memory) ??
    (store.partitions.length === 1 ? store.partitions[0] : undefined);
  const forgettable = store.scope === "agent_subject" ? selected : undefined;
  const [contents, compactions, footprint] = selected
    ? await Promise.all([
        getPartitionEntries(store.id, selected.partitionKey),
        listCompactions(store.id, selected.partitionKey),
        forgettable ? getSubjectFootprint(forgettable.partitionKey) : null,
      ])
    : [null, [], null];
  const partitionTitle = (_partitionKey: string, label: string) =>
    store.scope === "agent" ? store.owner.name : label;

  return (
    <div className="flex flex-col gap-4">
      <BreadcrumbTitle name={store.title} />
      <PageHeader
        eyebrow="Memory · agent"
        title={store.title}
        description={`${MEMORY_SCOPE_LABEL[store.scope]} · up to ${store.charLimit.toLocaleString("en-US")} characters per memory${store.requireApproval ? " · changes need approval" : ""}`}
        action={
          <Badge variant={store.isActive ? "default" : "secondary"}>
            {store.isActive ? "in use" : "off"}
          </Badge>
        }
      />

      <div className="flex flex-wrap gap-2">
        <AddMemoryEntryButton
          storeId={store.id}
          scope={store.scope}
          partitionKey={selected?.partitionKey ?? null}
        />
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`/agents/${store.owner.id}/edit`} />}
        >
          Configure in the agent
        </Button>
        <DeleteResourceButton
          endpoint={`/api/memory-stores/${store.id}`}
          resourceLabel="the memory"
          redirectTo="/memory"
          description={MEMORY_DELETE_DESCRIPTION}
        />
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>
              <Link
                href={`/agents/${store.owner.id}`}
                className="hover:underline"
              >
                {store.owner.name}
              </Link>
            </dd>
            <dt className="text-muted-foreground">How it is used</dt>
            <dd>{MEMORY_SCOPE_DESCRIPTION[store.scope]}</dd>
            {store.memoryKey && (
              <>
                <dt className="text-muted-foreground">x-memory-key</dt>
                <dd className="font-mono text-xs">{store.memoryKey}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Purpose</dt>
            <dd className="whitespace-pre-wrap">{store.purpose}</dd>
          </dl>
        </CardContent>
      </Card>

      <h2 className="text-sm font-medium">Memories</h2>
      {store.partitions.length === 0 ? (
        <EmptyState
          title="Nothing remembered yet"
          description={
            store.scope === "agent"
              ? "What the agent saves appears here."
              : store.scope === "custom"
                ? "What the agent saves for its x-memory-key appears here."
                : "Each x-subject-id gets its own memory here."
          }
        />
      ) : (
        <Table containerClassName={LIST_TABLE_CLASS}>
          <TableHeader>
            <TableRow>
              <TableHead>{PARTITION_HEADING[store.scope]}</TableHead>
              <TableHead>Entries</TableHead>
              <TableHead>To approve</TableHead>
              <TableHead>Used</TableHead>
              <TableHead>Revision</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {store.partitions.map((partition) => (
              <TableRow
                key={partition.partitionKey}
                className={cn(
                  partition.partitionKey === selected?.partitionKey &&
                    "bg-muted/50",
                )}
              >
                <TableCell>
                  <Link
                    href={`?memory=${encodeURIComponent(partition.partitionKey)}`}
                    className="font-medium hover:underline"
                  >
                    {partitionTitle(partition.partitionKey, partition.label)}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {partition.entries}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {partition.pending || "—"}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {partition.chars.toLocaleString("en-US")} /{" "}
                  {store.charLimit.toLocaleString("en-US")}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums">
                  {partition.revision}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {partition.updatedAt.toISOString().slice(0, 10)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selected && contents && (
        <>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              {partitionTitle(selected.partitionKey, selected.label)}
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                rev {contents.revision}
              </span>
            </h2>
            {forgettable && footprint && (
              <ForgetSubjectButton
                subjectId={forgettable.partitionKey}
                footprint={footprint}
                redirectTo={`/memory/${store.id}`}
              />
            )}
          </div>
          {contents.proposals.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Waiting for approval ({contents.proposals.length}). Changes the
                agent proposed; approving one saves it as the agent's.
              </p>
              <MemoryProposals
                storeId={store.id}
                proposals={contents.proposals}
              />
            </>
          )}
          <MemoryEntriesTable
            storeId={store.id}
            entries={contents.entries}
            deleted={contents.deleted}
          />
          <MemoryCompactions
            compactions={compactions}
            pinnedChars={contents.entries
              .filter((entry) => entry.pinned)
              .reduce((sum, entry) => sum + entry.content.length, 0)}
            target={compactionTarget(store.charLimit)}
          />
        </>
      )}
    </div>
  );
}
