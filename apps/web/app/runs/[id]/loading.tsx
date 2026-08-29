import { LIST_SHELL_CLASS } from "@/components/list-search";
import { Skeleton } from "@/components/ui/skeleton";

export default function RunDetailLoading() {
  return (
    <div className={LIST_SHELL_CLASS}>
      <div className="flex flex-col gap-2 lg:shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-7 w-64 max-w-full" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-16 w-3/4" />
          <Skeleton className="ml-auto h-16 w-2/3" />
          <Skeleton className="h-24 w-4/5" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-4 py-2.5">
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-4 py-2.5">
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="p-3">
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
