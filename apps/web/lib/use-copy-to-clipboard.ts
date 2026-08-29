"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export function useCopyToClipboard(timeout = 1500) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function copy(text: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Clipboard is not available in this browser context.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), timeout);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  }

  return { copied, copy };
}
