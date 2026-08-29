"use client";

import Link from "next/link";
import { ActiveBadge } from "@/components/active-badge";
import { LIST_TABLE_CLASS, ListSearch } from "@/components/list-search";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { listAgents } from "@/lib/queries";
import { useListFilter } from "@/lib/use-list-filter";

type AgentRow = Awaited<ReturnType<typeof listAgents>>[number];

export function AgentsList({ agents }: { agents: AgentRow[] }) {
  const { query, setQuery, filtered } = useListFilter(
    agents,
    (agent) => agent.name,
  );

  return (
    <>
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder="Search by name…"
        filtered={filtered.length}
        total={agents.length}
      />
      <Table containerClassName={LIST_TABLE_CLASS}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Max steps</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((agent) => (
            <TableRow key={agent.id}>
              <TableCell>
                <Link
                  href={`/agents/${agent.id}`}
                  className="font-medium hover:underline"
                >
                  {agent.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {agent.model}
              </TableCell>
              <TableCell>{agent.maxSteps}</TableCell>
              <TableCell>
                <ActiveBadge isActive={agent.isActive} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
