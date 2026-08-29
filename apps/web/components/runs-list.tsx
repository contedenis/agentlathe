"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LIST_TABLE_CLASS, SearchInput } from "@/components/list-search";
import { RunStatusBadge } from "@/components/run-status-badge";
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
import type { listRunsPage } from "@/lib/queries";
import { SOURCE_LABEL, SOURCE_ORDER, sourceLabel } from "@/lib/run-sources";

type RunRow = Awaited<ReturnType<typeof listRunsPage>>["rows"][number];

const SOURCES = [
  { value: "", label: "All sources" },
  ...SOURCE_ORDER.map((source) => ({
    value: source,
    label: SOURCE_LABEL[source],
  })),
];

export function RunsList({
  runs,
  total,
  query,
  source,
  page,
  pageSize,
}: {
  runs: RunRow[];
  total: number;
  query: string;
  source: string;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function hrefFor(nextQuery: string, nextSource: string, nextPage: number) {
    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextSource) params.set("source", nextSource);
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function onSearch(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => router.replace(hrefFor(next, source, 1)),
      300,
    );
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0">
        <SearchInput
          value={value}
          onChange={onSearch}
          placeholder="Search by agent…"
        />
        <div className="flex gap-1.5">
          {SOURCES.map((option) => (
            <Button
              key={option.value || "all"}
              variant={source === option.value ? "secondary" : "ghost"}
              size="sm"
              nativeButton={false}
              render={<Link href={hrefFor(query, option.value, 1)} />}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-faint">
          {total} {total === 1 ? "result" : "results"}
        </span>
      </div>

      <Table containerClassName={LIST_TABLE_CLASS}>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="py-10 text-center text-muted-foreground"
              >
                No runs match this filter.
              </TableCell>
            </TableRow>
          ) : (
            runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    href={`/runs/${run.id}`}
                    className="font-mono text-[12px] font-medium hover:underline"
                  >
                    {run.createdAt?.toLocaleString("en-US") ?? "—"}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/agents/${run.agentId}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {run.agentName}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-[11px] text-faint uppercase">
                    {sourceLabel(run.source)}
                  </span>
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="font-mono text-[12px] text-faint tabular-nums">
                  {(run.durationMs / 1000).toFixed(1)}s
                </TableCell>
                <TableCell>
                  {run.openDrafts > 0 ? (
                    <Badge variant="default">{run.openDrafts} open</Badge>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-3 lg:shrink-0">
        <span className="font-mono text-[11px] text-faint">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            // Disabled it stays a real button; enabled it renders an anchor.
            nativeButton={page <= 1}
            render={
              page > 1 ? (
                <Link href={hrefFor(query, source, page - 1)} />
              ) : undefined
            }
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            nativeButton={page >= totalPages}
            render={
              page < totalPages ? (
                <Link href={hrefFor(query, source, page + 1)} />
              ) : undefined
            }
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
