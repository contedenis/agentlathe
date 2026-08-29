"use client";

import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";

export const LIST_TABLE_CLASS =
  "rounded-lg border bg-card lg:min-h-0 lg:flex-1 lg:overflow-y-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:border-b [&_thead_th]:bg-card";

export const LIST_SHELL_CLASS =
  "flex flex-col gap-5 lg:h-[var(--list-shell-height)] lg:min-h-0";

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full max-w-xs">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-8"
      />
    </div>
  );
}

export function ListSearch({
  value,
  onChange,
  placeholder,
  filtered,
  total,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  filtered: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 lg:shrink-0">
      <SearchInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
      <span className="font-mono text-[11px] text-faint">
        {value.trim() ? `${filtered} of ${total}` : total}
      </span>
    </div>
  );
}
