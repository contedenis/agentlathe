"use client";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import type { ModelOption } from "@/lib/openrouter-models";

function formatContextLength(contextLength: number | null): string | null {
  if (!contextLength) return null;
  return contextLength >= 1000
    ? `${Math.round(contextLength / 1000)}k ctx`
    : `${contextLength} ctx`;
}

const MAX_VISIBLE_MATCHES = 50;

export function ModelCombobox({
  id,
  value,
  onChange,
  models,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  models: ModelOption[];
}) {
  const query = value.trim().toLowerCase();
  const matches = query
    ? models.filter((model) => model.id.toLowerCase().includes(query))
    : models;
  const visible = matches.slice(0, MAX_VISIBLE_MATCHES);

  return (
    <Combobox
      items={visible.map((model) => model.id)}
      inputValue={value}
      onInputValueChange={onChange}
      openOnInputClick
    >
      <ComboboxInput
        id={id}
        placeholder="~deepseek/deepseek-v4-flash-latest"
        required
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {models.length === 0
            ? "Could not load the model catalog — you can still type the slug."
            : "No model matches — the typed text is used."}
        </ComboboxEmpty>
        <ComboboxList>
          {visible.map((model) => (
            <ComboboxItem key={model.id} value={model.id}>
              <span className="min-w-0 flex-1 truncate">{model.id}</span>
              {formatContextLength(model.contextLength) && (
                <span className="ml-2 shrink-0 pr-6 text-xs text-muted-foreground">
                  {formatContextLength(model.contextLength)}
                </span>
              )}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
