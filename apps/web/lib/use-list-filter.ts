"use client";

import { useState } from "react";

export function useListFilter<T>(items: T[], toText: (item: T) => string) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? items.filter((item) => toText(item).toLowerCase().includes(normalized))
    : items;
  return { query, setQuery, filtered };
}
