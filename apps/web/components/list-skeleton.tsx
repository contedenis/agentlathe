import { LIST_SHELL_CLASS, LIST_TABLE_CLASS } from "@/components/list-search";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ListSkeleton({
  columns,
  rows = 6,
}: {
  columns: number;
  rows?: number;
}) {
  const columnIndexes = Array.from({ length: columns }, (_, i) => i);
  const rowIndexes = Array.from({ length: rows }, (_, i) => i);

  return (
    <div className={LIST_SHELL_CLASS}>
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 shrink-0" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <div className={cn(LIST_TABLE_CLASS, "overflow-hidden")}>
        <div className="flex gap-4 border-b px-4 py-[9px]">
          {columnIndexes.map((i) => (
            <Skeleton key={i} className="h-3 w-16" />
          ))}
        </div>
        <div className="divide-y">
          {rowIndexes.map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-[11px]">
              {columnIndexes.map((j) => (
                <Skeleton key={j} className="h-4 w-20" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
