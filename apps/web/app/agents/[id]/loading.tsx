import { Skeleton } from "@/components/ui/skeleton";

export default function AgentDetailLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>

      <div className="flex gap-2">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-20" />
      </div>

      <div className="flex flex-col gap-4 lg:h-[75vh] lg:flex-row">
        <div className="flex flex-col gap-3 lg:w-96 lg:shrink-0">
          <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
            <Skeleton className="h-7 flex-1" />
            <Skeleton className="h-7 flex-1" />
            <Skeleton className="h-7 flex-1" />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
        <div className="flex-1 overflow-hidden rounded-xl border bg-card p-3">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
