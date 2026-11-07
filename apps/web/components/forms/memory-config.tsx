"use client";

import { RUN_LABEL_MAX_LENGTH } from "@agentlathe/db/constants";
import { MemorySettingsFields } from "@/components/forms/memory-settings-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MEMORY_SCOPE_DESCRIPTION,
  MEMORY_SCOPE_LABEL,
} from "@/lib/memory-rules";
import {
  type AgentMemoryConfig,
  MEMORY_TYPES,
  type MemoryType,
} from "@/lib/memory-settings";

const TYPE_LABEL: Record<MemoryType, string> = {
  none: "Off",
  ...MEMORY_SCOPE_LABEL,
};

const TYPE_DESCRIPTION: Record<MemoryType, string> = {
  none: "The agent remembers nothing between runs.",
  ...MEMORY_SCOPE_DESCRIPTION,
};

export function MemoryConfig({
  value,
  onChange,
}: {
  value: AgentMemoryConfig;
  onChange: (value: AgentMemoryConfig) => void;
}) {
  const { type } = value;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="memory-type">Memory</Label>
        <Select
          value={type}
          items={MEMORY_TYPES.map((option) => ({
            value: option,
            label: TYPE_LABEL[option],
          }))}
          onValueChange={(next) =>
            onChange({ ...value, type: next as MemoryType })
          }
        >
          <SelectTrigger id="memory-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEMORY_TYPES.map((option) => (
              <SelectItem key={option} value={option}>
                {TYPE_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {TYPE_DESCRIPTION[type]}
        </p>
      </div>

      {type === "custom" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="memory-key">x-memory-key</Label>
          <Input
            id="memory-key"
            value={value.memoryKey}
            onChange={(e) => onChange({ ...value, memoryKey: e.target.value })}
            maxLength={RUN_LABEL_MAX_LENGTH}
            placeholder="example-key"
            className="font-mono"
          />
        </div>
      )}

      {type !== "none" && (
        <details className="rounded-lg border p-3" open={type === "custom"}>
          <summary className="cursor-pointer text-sm">Settings</summary>
          <div className="mt-3">
            <MemorySettingsFields
              idPrefix={`memory-${type}`}
              value={value.settings[type]}
              onChange={(settings) =>
                onChange({
                  ...value,
                  settings: { ...value.settings, [type]: settings },
                })
              }
              purposePlaceholder={
                type === "custom"
                  ? "What this memory keeps, e.g. decisions and conventions of the payments team."
                  : undefined
              }
            />
          </div>
        </details>
      )}

      {type !== "none" && (
        <p className="text-sm text-muted-foreground">
          The memory is added to the end of the agent&apos;s instructions on
          every run that uses it, and the agent can change it. Switching to
          another type keeps what this one remembers.
        </p>
      )}
    </div>
  );
}
