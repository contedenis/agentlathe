"use client";

import { MAX_MEMORY_CHAR_LIMIT } from "@agentlathe/db/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type MemorySettings,
  MIN_MEMORY_CHAR_LIMIT,
} from "@/lib/memory-settings";

export function MemorySettingsFields({
  idPrefix,
  value,
  onChange,
  purposePlaceholder,
}: {
  idPrefix: string;
  value: MemorySettings;
  onChange: (value: MemorySettings) => void;
  purposePlaceholder?: string;
}) {
  const set = <K extends keyof MemorySettings>(
    key: K,
    next: MemorySettings[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-purpose`}>Purpose</Label>
        <Textarea
          id={`${idPrefix}-purpose`}
          value={value.purpose}
          onChange={(e) => set("purpose", e.target.value)}
          rows={6}
          placeholder={purposePlaceholder}
        />
        <span className="text-xs text-muted-foreground">
          What the agent should keep here. It reads this next to the entries.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-limit`}>Character limit</Label>
        <Input
          id={`${idPrefix}-limit`}
          type="number"
          inputMode="numeric"
          min={MIN_MEMORY_CHAR_LIMIT}
          max={MAX_MEMORY_CHAR_LIMIT}
          step={500}
          value={value.charLimit}
          onChange={(e) => set("charLimit", e.target.value)}
          className="font-mono"
        />
        <span className="text-xs text-muted-foreground">
          The most each memory can hold. About{" "}
          {Math.ceil(Number(value.charLimit) / 4 || 0).toLocaleString("en-US")}{" "}
          tokens of every run's instructions when full. Past 90%, the agent's
          model consolidates it to 60% after the run.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id={`${idPrefix}-approval`}
            checked={value.requireApproval}
            onCheckedChange={(checked) => set("requireApproval", checked)}
          />
          <Label htmlFor={`${idPrefix}-approval`}>Require approval</Label>
        </div>
        <span className="text-xs text-muted-foreground">
          The agent's changes wait in Memory until a person approves them. Use
          it when the agent reads content from people you do not trust.
        </span>
      </div>
    </div>
  );
}
