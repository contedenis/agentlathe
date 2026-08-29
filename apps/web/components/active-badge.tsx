import { cn } from "@/lib/utils";

export function ActiveBadge({ isActive }: { isActive: boolean | null }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full px-[9px] py-[2px] font-mono text-[11px] font-medium tracking-[0.01em]",
        isActive
          ? "bg-success/15 text-success"
          : "border bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-[5px] rounded-full",
          isActive ? "bg-success" : "bg-faint",
        )}
      />
      {isActive ? "active" : "inactive"}
    </span>
  );
}
