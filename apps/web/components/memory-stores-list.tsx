"use client";

import Link from "next/link";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import {
  LIST_SHELL_CLASS,
  LIST_TABLE_CLASS,
  ListSearch,
} from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MEMORY_SCOPE_LABEL } from "@/lib/memory-rules";
import type { MemoryStoreListRow } from "@/lib/queries-memory";
import { useListFilter } from "@/lib/use-list-filter";

export const MEMORY_DELETE_DESCRIPTION =
  "Everything it remembers and its history are deleted. The agent keeps running without it until you choose a memory again.";

export function MemoryStoresList({ stores }: { stores: MemoryStoreListRow[] }) {
  const { query, setQuery, filtered } = useListFilter(
    stores,
    (store) => `${store.owner.name} ${store.memoryKey ?? ""}`,
  );

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow="Workshop · memory"
        title="Memory"
        description="What agents keep between runs. An agent gets its memory in its configuration; here you read and fix what it remembers."
      />
      {stores.length === 0 ? (
        <EmptyState
          title="No memory yet"
          description="Choose a memory in an agent's configuration: one for all its runs, one per subject, or one behind an x-memory-key."
        />
      ) : (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search by agent or key…"
            filtered={filtered.length}
            total={stores.length}
          />
          <Table containerClassName={LIST_TABLE_CLASS}>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Memories</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((store) => (
                <TableRow key={store.id}>
                  <TableCell>
                    <Link
                      href={`/agents/${store.owner.id}`}
                      className="text-muted-foreground hover:underline"
                    >
                      {store.owner.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/memory/${store.id}`}
                      className="font-medium hover:underline"
                    >
                      {MEMORY_SCOPE_LABEL[store.scope]}
                    </Link>
                    {store.memoryKey && (
                      <span className="block font-mono text-xs text-muted-foreground">
                        x-memory-key: {store.memoryKey}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {store.partitions}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {store.charLimit.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={store.isActive ? "default" : "secondary"}>
                      {store.isActive ? "in use" : "off"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <DeleteResourceButton
                        endpoint={`/api/memory-stores/${store.id}`}
                        resourceLabel="the memory"
                        redirectTo="/memory"
                        description={MEMORY_DELETE_DESCRIPTION}
                        size="sm"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
