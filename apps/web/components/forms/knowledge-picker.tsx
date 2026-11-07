"use client";

import {
  CHARS_PER_TOKEN,
  KNOWLEDGE_MODES,
  type KnowledgeMode,
} from "@agentlathe/db/constants";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmt } from "@/lib/format";
import {
  alwaysReadUsage,
  KNOWLEDGE_MODE_DESCRIPTION,
  KNOWLEDGE_MODE_LABEL,
  type KnowledgeLink,
} from "@/lib/knowledge-modes";

export type KnowledgeCatalogItem = {
  id: string;
  name: string;
  description: string;
  chars: number;
};

function sizeOf(collection: KnowledgeCatalogItem): string {
  return collection.chars === 0
    ? "empty"
    : `about ${fmt(Math.ceil(collection.chars / CHARS_PER_TOKEN))} tokens`;
}

export function KnowledgePicker({
  collections,
  value,
  onChange,
  contextLength,
}: {
  collections: KnowledgeCatalogItem[];
  value: KnowledgeLink[];
  onChange: (value: KnowledgeLink[]) => void;
  contextLength: number | null;
}) {
  const [query, setQuery] = useState("");
  const [removedModes, setRemovedModes] = useState<
    Record<string, KnowledgeMode>
  >({});

  if (collections.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No collections yet.{" "}
        <Link href="/knowledge" className="underline">
          Create one in Knowledge
        </Link>{" "}
        and attach it here.
      </p>
    );

  const byId = new Map(collections.map((c) => [c.id, c]));
  const attached = value.flatMap((link) => {
    const collection = byId.get(link.collectionId);
    return collection ? [{ ...collection, mode: link.mode }] : [];
  });
  const needle = query.trim().toLowerCase();
  const available = collections.filter(
    (collection) =>
      !value.some((link) => link.collectionId === collection.id) &&
      collection.name.toLowerCase().includes(needle),
  );
  const remaining = collections.length - attached.length;

  const add = (name: string | null) => {
    const collection = collections.find((c) => c.name === name);
    if (
      !collection ||
      value.some((link) => link.collectionId === collection.id)
    )
      return;
    onChange([
      ...value,
      {
        collectionId: collection.id,
        mode: removedModes[collection.id] ?? "search",
      },
    ]);
    setQuery("");
  };
  const remove = (id: string) => {
    const link = value.find((candidate) => candidate.collectionId === id);
    if (link) setRemovedModes({ ...removedModes, [id]: link.mode });
    onChange(value.filter((candidate) => candidate.collectionId !== id));
  };
  const setMode = (id: string, mode: KnowledgeMode) =>
    onChange(
      value.map((link) =>
        link.collectionId === id ? { ...link, mode } : link,
      ),
    );
  const usage = alwaysReadUsage(
    value,
    (id) => byId.get(id)?.chars ?? 0,
    contextLength,
  );

  return (
    <div className="flex flex-col gap-3">
      {attached.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No collections attached. The agent answers without documents.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {attached.map((collection) => (
            <li
              key={collection.id}
              className="flex flex-wrap items-start justify-between gap-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm">{collection.name}</span>
                <span className="text-xs text-muted-foreground">
                  {[collection.description, sizeOf(collection)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {KNOWLEDGE_MODE_DESCRIPTION[collection.mode]}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Select
                  value={collection.mode}
                  items={KNOWLEDGE_MODES.map((mode) => ({
                    value: mode,
                    label: KNOWLEDGE_MODE_LABEL[mode],
                  }))}
                  onValueChange={(next) =>
                    setMode(collection.id, next as KnowledgeMode)
                  }
                >
                  <SelectTrigger
                    className="w-36"
                    aria-label={`How the agent uses ${collection.name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KNOWLEDGE_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {KNOWLEDGE_MODE_LABEL[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${collection.name}`}
                  onClick={() => remove(collection.id)}
                >
                  <XIcon />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 && (
        <Combobox
          items={available.map((collection) => collection.name)}
          value={null}
          onValueChange={add}
          inputValue={query}
          onInputValueChange={setQuery}
          openOnInputClick
          autoHighlight
        >
          <ComboboxInput
            aria-label="Add a collection"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={`Add a collection (${remaining} available)…`}
          />
          <ComboboxContent>
            <ComboboxEmpty>No collection matches.</ComboboxEmpty>
            <ComboboxList>
              {available.map((collection) => (
                <ComboboxItem key={collection.id} value={collection.name}>
                  <span className="min-w-0 flex-1 truncate">
                    {collection.name}
                  </span>
                  <span className="ml-2 shrink-0 pr-6 text-xs text-muted-foreground">
                    {sizeOf(collection)}
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )}

      {usage.tokens > 0 && (
        <p
          className={
            usage.fits
              ? "text-sm text-muted-foreground"
              : "text-sm text-destructive"
          }
        >
          {`Read whole: about ${fmt(usage.tokens)} tokens of the ${fmt(usage.budget)} available, a quarter of the model's context.`}
          {!usage.fits &&
            " Over it, runs search the collections that do not fit instead, and say so on the run."}
        </p>
      )}
    </div>
  );
}
