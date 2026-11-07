"use client";

import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { KnowledgeCollectionDialog } from "@/components/knowledge-collection-dialog";
import {
  LIST_SHELL_CLASS,
  LIST_TABLE_CLASS,
  ListSearch,
} from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import type { CollectionListRow } from "@/lib/queries-knowledge";
import { useListFilter } from "@/lib/use-list-filter";

export function KnowledgeCollectionsList({
  collections,
}: {
  collections: CollectionListRow[];
}) {
  const { query, setQuery, filtered } = useListFilter(
    collections,
    (collection) => collection.name,
  );
  const newButton = (label: string) => (
    <KnowledgeCollectionDialog trigger={<Button>{label}</Button>} />
  );

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow="Workshop · knowledge"
        title="Knowledge"
        description="Documents your agents can consult. Group them in collections and attach a collection to an agent in its configuration."
        action={newButton("New collection")}
      />
      {collections.length === 0 ? (
        <EmptyState
          title="No collections yet"
          description="Create a collection, upload PDF, Markdown or text files, and attach it to an agent: it searches them when it needs to, or reads them whole."
          action={newButton("Create collection")}
        />
      ) : (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search by name…"
            filtered={filtered.length}
            total={collections.length}
          />
          <Table containerClassName={LIST_TABLE_CLASS}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Documents</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Agents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((collection) => (
                <TableRow key={collection.id}>
                  <TableCell>
                    <Link
                      href={`/knowledge/${collection.id}`}
                      className="font-medium hover:underline"
                    >
                      {collection.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground">
                    {collection.description}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    <span className="flex items-center gap-2">
                      {collection.documents}
                      {collection.waiting > 0 && (
                        <Badge variant="secondary">
                          {collection.waiting} in progress
                        </Badge>
                      )}
                      {collection.failed > 0 && (
                        <Badge variant="destructive">
                          {collection.failed} failed
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {formatBytes(collection.size)}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {collection.agents}
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
