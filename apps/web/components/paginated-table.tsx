"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 10;

export function PaginatedTable({
  head,
  children,
  pageSize = PAGE_SIZE,
  empty,
}: {
  head: ReactNode;
  children: ReactNode;
  pageSize?: number;
  empty?: ReactNode;
}) {
  const rows = Children.toArray(children);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const [page, setPage] = useState(0);
  const current = Math.min(page, pages - 1);
  const start = current * pageSize;
  const visible = rows.slice(start, start + pageSize);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">{head}</TableRow>
        </TableHeader>
        <TableBody>{visible}</TableBody>
      </Table>

      {rows.length === 0 && empty}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-4 border-t px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span>
            {start + 1}–{Math.min(start + pageSize, rows.length)} of{" "}
            {rows.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              className="rounded-md border p-1 transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              className="rounded-md border p-1 transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
