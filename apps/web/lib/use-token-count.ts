"use client";

import { models, Tokenizer } from "ai-tokenizer";
import { useEffect, useMemo, useState } from "react";

const ENCODING_LOADERS = {
  o200k_base: () => import("ai-tokenizer/encoding/o200k_base"),
  cl100k_base: () => import("ai-tokenizer/encoding/cl100k_base"),
  p50k_base: () => import("ai-tokenizer/encoding/p50k_base"),
  claude: () => import("ai-tokenizer/encoding/claude"),
} as const;
type EncodingName = keyof typeof ENCODING_LOADERS;
const DEFAULT_ENCODING: EncodingName = "o200k_base";

const modelRegistry = models as Record<string, { encoding: string }>;

function encodingFor(model: string): EncodingName {
  const name = modelRegistry[model]?.encoding;
  return name && name in ENCODING_LOADERS
    ? (name as EncodingName)
    : DEFAULT_ENCODING;
}

const cache = new Map<EncodingName, Tokenizer>();

export function useTokenCount(text: string, model: string) {
  const encoding = encodingFor(model);
  const [tokenizer, setTokenizer] = useState<Tokenizer | null>(
    () => cache.get(encoding) ?? null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const cached = cache.get(encoding);
    if (cached) {
      setTokenizer(cached);
      return;
    }
    let active = true;
    setLoading(true);
    ENCODING_LOADERS[encoding]()
      .then((mod) => {
        const built = new Tokenizer(mod);
        cache.set(encoding, built);
        if (active) setTokenizer(built);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [encoding]);

  const tokens = useMemo(
    () => (tokenizer && text ? tokenizer.count(text) : 0),
    [tokenizer, text],
  );

  return { tokens, loading };
}
