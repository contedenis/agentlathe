import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  eyebrow,
  action,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div>
        {eyebrow && (
          <p className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-[25px] font-semibold tracking-[-0.025em]">
          {title}
        </h1>
        {description && (
          <p className="mt-[3px] text-[13.5px] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
