"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiRequest } from "@/lib/mutate";

export type AppSettings = {
  trackDashboardRuns: boolean;
  trackV1Runs: boolean;
  trackMcpRuns: boolean;
  agentRunTtlDays: number;
  transcriptTtlDays: number;
};

export const SOURCES = [
  {
    key: "trackDashboardRuns",
    label: "Dashboard",
    hint: "Chats from the dashboard.",
  },
  { key: "trackV1Runs", label: "API /v1", hint: "OpenAI-compatible clients." },
  { key: "trackMcpRuns", label: "MCP", hint: "Agents exposed as MCP." },
] as const;

export function TrackingToggles({ initial }: { initial: AppSettings }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [ttlText, setTtlText] = useState(String(initial.agentRunTtlDays));
  const [transcriptTtlText, setTranscriptTtlText] = useState(
    String(initial.transcriptTtlDays),
  );
  const [pending, startTransition] = useTransition();

  async function save(values: Partial<AppSettings>) {
    const previous = settings;
    setSettings({ ...settings, ...values });
    try {
      await apiRequest("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(values),
      });
      startTransition(() => router.refresh());
    } catch (err) {
      setSettings(previous);
      setTtlText(String(previous.agentRunTtlDays));
      setTranscriptTtlText(String(previous.transcriptTtlDays));
      toast.error(
        err instanceof Error ? err.message : "Could not save the change.",
      );
    }
  }

  function commitTtl() {
    const parsed = Number.parseInt(ttlText, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setTtlText(String(settings.agentRunTtlDays));
      toast.error("Retention must be an integer of 0 or more.");
      return;
    }
    if (parsed === settings.agentRunTtlDays) return;
    void save({ agentRunTtlDays: parsed });
  }

  function commitTranscriptTtl() {
    const parsed = Number.parseInt(transcriptTtlText, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setTranscriptTtlText(String(settings.transcriptTtlDays));
      toast.error("Retention must be an integer of 0 or more.");
      return;
    }
    if (parsed === settings.transcriptTtlDays) return;
    void save({ transcriptTtlDays: parsed });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {SOURCES.map((source) => (
          <div
            key={source.key}
            className="flex items-center justify-between gap-4"
          >
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={source.key} className="cursor-pointer">
                {source.label}
              </Label>
              <span className="text-xs text-muted-foreground">
                {source.hint}
              </span>
            </div>
            <Switch
              id={source.key}
              checked={settings[source.key]}
              disabled={pending}
              onCheckedChange={(checked) => save({ [source.key]: checked })}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 border-t pt-4">
        <Label htmlFor="agentRunTtlDays">Retention (days)</Label>
        <Input
          id="agentRunTtlDays"
          type="number"
          min={0}
          value={ttlText}
          disabled={pending}
          onChange={(e) => setTtlText(e.target.value)}
          onBlur={commitTtl}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="max-w-[120px]"
        />
        <span className="text-xs text-muted-foreground">
          {settings.agentRunTtlDays === 0
            ? "0 = no limit, nothing is ever deleted."
            : `Runs older than ${settings.agentRunTtlDays} days are deleted automatically.`}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 border-t pt-4">
        <Label htmlFor="transcriptTtlDays">Transcript retention (days)</Label>
        <Input
          id="transcriptTtlDays"
          type="number"
          min={0}
          value={transcriptTtlText}
          disabled={pending}
          onChange={(e) => setTranscriptTtlText(e.target.value)}
          onBlur={commitTranscriptTtl}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="max-w-[120px]"
        />
        <span className="text-xs text-muted-foreground">
          {settings.transcriptTtlDays === 0
            ? "0 = no limit, nothing is ever deleted."
            : `Transcripts older than ${settings.transcriptTtlDays} days are deleted automatically.`}
        </span>
      </div>
    </div>
  );
}
