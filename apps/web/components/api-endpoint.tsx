"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export function ApiEndpoint() {
  const [origin, setOrigin] = useState("");
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => setOrigin(window.location.origin), []);

  const url = origin ? `${origin}/v1` : "…/v1";

  return (
    <div className="rounded-md border bg-sidebar-accent p-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-faint uppercase">
        <span className="size-1.5 rounded-full bg-success ring-[3px] ring-success/15" />
        API OpenAI-compatible
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] text-sidebar-foreground">
          {url}
        </span>
        <button
          type="button"
          onClick={() => copy(url)}
          aria-label="Copy base URL"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-primary"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
