import { cn } from "@/lib/utils";

export function RunStatusBadge({ status }: { status: string }) {
  const isError = status === "error";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full px-[9px] py-[2px] font-mono text-[11px] font-medium tracking-[0.01em] whitespace-nowrap",
        isError
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-[5px] rounded-full",
          isError ? "bg-destructive" : "bg-muted-foreground",
        )}
      />
      {status}
    </span>
  );
}
