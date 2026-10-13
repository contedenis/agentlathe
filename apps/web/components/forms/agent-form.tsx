"use client";

import {
  AGENT_SLUG_MAX_LENGTH,
  AGENT_SLUG_PATTERN,
  agentSlug,
} from "@agentlathe/db/naming";
import { ExternalLinkIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ModelCombobox } from "@/components/forms/model-combobox";
import {
  type McpToolSelection,
  ToolPicker,
  type ToolPickerCatalogs,
} from "@/components/forms/tool-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fmt } from "@/lib/format";
import { apiRequest } from "@/lib/mutate";
import type { ModelOption } from "@/lib/openrouter-models";
import { useTokenCount } from "@/lib/use-token-count";

const SystemPromptCanvas = dynamic(
  () =>
    import("@/components/forms/system-prompt-canvas").then(
      (mod) => mod.SystemPromptCanvas,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-y-0 right-0 z-50 w-[min(680px,100vw)] max-w-full border-l bg-popover p-4">
        <Skeleton className="h-full w-full" />
      </div>
    ),
  },
);

type AgentFormValues = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  model: string;
  systemPrompt: string | null;
  maxSteps: number | null;
  recordTraffic: boolean;
  autoEvaluate: boolean;
  skillIds: string[];
  toolIds: string[];
  subAgentIds: string[];
  mcpTools: McpToolSelection[];
};

export function AgentForm({
  catalogs,
  models,
  initial,
}: {
  catalogs: ToolPickerCatalogs;
  models: ModelOption[];
  initial?: AgentFormValues;
}) {
  const router = useRouter();
  const mode = initial ? "edit" : "create";

  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [maxSteps, setMaxSteps] = useState(String(initial?.maxSteps ?? 20));
  const [recordTraffic, setRecordTraffic] = useState(
    initial?.recordTraffic ?? false,
  );
  const [autoEvaluate, setAutoEvaluate] = useState(
    initial?.autoEvaluate ?? true,
  );
  const [skillIds, setSkillIds] = useState<string[]>(initial?.skillIds ?? []);
  const [toolIds, setToolIds] = useState<string[]>(initial?.toolIds ?? []);
  const [subAgentIds, setSubAgentIds] = useState<string[]>(
    initial?.subAgentIds ?? [],
  );
  const [mcpTools, setMcpTools] = useState<McpToolSelection[]>(
    initial?.mcpTools ?? [],
  );
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasMounted, setCanvasMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tokens: promptTokens, loading: tokensLoading } = useTokenCount(
    systemPrompt,
    model,
  );

  function openCanvas() {
    setCanvasMounted(true);
    setCanvasOpen(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsedMaxSteps = Number.parseInt(maxSteps, 10);
    if (!Number.isFinite(parsedMaxSteps) || parsedMaxSteps <= 0) {
      setError("Max steps must be a positive integer.");
      return;
    }

    const finalSlug = slug || agentSlug(name);
    if (!AGENT_SLUG_PATTERN.test(finalSlug)) {
      setError(
        "The ID may only contain lowercase letters, digits, dots, underscores and hyphens, and must start and end with a letter or digit.",
      );
      return;
    }

    setPending(true);
    const body = {
      name,
      slug: finalSlug,
      description: description || null,
      model,
      systemPrompt: systemPrompt || null,
      maxSteps: parsedMaxSteps,
      recordTraffic,
      autoEvaluate,
      skillIds,
      toolIds,
      subAgentIds,
      mcpTools,
    };
    try {
      if (mode === "create") {
        const created = await apiRequest<{ id: string }>("/api/agents", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("Agent created.");
        router.push(`/agents/${created.id}`);
      } else {
        await apiRequest(`/api/agents/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Agent updated.");
        router.push(`/agents/${initial?.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[18px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(agentSlug(e.target.value));
                }}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="slug">
                ID
                <span className="ml-1.5 font-normal text-muted-foreground">
                  — used as the /v1 model id and in the MCP URL
                </span>
              </Label>
              <Input
                id="slug"
                value={slug}
                maxLength={AGENT_SLUG_MAX_LENGTH}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="my-agent"
                className="font-mono"
                required
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model">Model (provider slug)</Label>
            <ModelCombobox
              id="model"
              value={model}
              onChange={setModel}
              models={models}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>
              System prompt
              <span className="ml-1.5 font-normal text-muted-foreground">
                — defines how the agent behaves
              </span>
            </Label>
            <div className="relative overflow-hidden rounded-lg border bg-gradient-to-b from-card to-muted/30 p-3.5">
              <span className="absolute inset-y-0 left-0 w-0.5 bg-primary/30" />
              <div className="flex items-center justify-between gap-3">
                <p
                  className={`font-mono text-[11px] text-muted-foreground${tokensLoading ? " opacity-50" : ""}`}
                >
                  <span className="text-primary">~{fmt(promptTokens)}</span>{" "}
                  tokens · {fmt(systemPrompt.length)} chars
                </p>
                <Button type="button" size="sm" onClick={openCanvas}>
                  <ExternalLinkIcon />
                  Edit in canvas
                </Button>
              </div>
              <button
                type="button"
                onClick={openCanvas}
                className="mt-3 block w-full cursor-pointer text-left"
              >
                {systemPrompt ? (
                  <div className="relative max-h-28 overflow-hidden rounded-md border bg-background/60 p-3">
                    <div className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">
                      {systemPrompt}
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-gradient-to-t from-background/90 to-transparent" />
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed bg-background/40 p-4 text-center text-[12px] text-muted-foreground">
                    No system prompt yet — click to write one.
                  </div>
                )}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maxSteps">Max steps</Label>
            <Input
              id="maxSteps"
              type="number"
              min={1}
              max={200}
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
              required
              className="max-w-[120px]"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
        </CardHeader>
        <CardContent>
          <ToolPicker
            catalogs={catalogs}
            skillIds={skillIds}
            onSkillIdsChange={setSkillIds}
            toolIds={toolIds}
            onToolIdsChange={setToolIds}
            subAgentIds={subAgentIds}
            onSubAgentIdsChange={setSubAgentIds}
            mcpTools={mcpTools}
            onMcpToolsChange={setMcpTools}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recording and evaluation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[18px]">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Switch
                id="recordTraffic"
                checked={recordTraffic}
                onCheckedChange={setRecordTraffic}
              />
              <Label htmlFor="recordTraffic">Record external traffic</Label>
            </div>
            <p className="text-sm text-muted-foreground">
              Stores the messages of the calls this agent answers through the
              API and MCP, so you can review them. Playground runs are always
              stored. Transcripts are kept unredacted.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Switch
                id="autoEvaluate"
                checked={autoEvaluate}
                onCheckedChange={setAutoEvaluate}
              />
              <Label htmlFor="autoEvaluate">
                Evaluate new runs automatically
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              Judges every run with a stored transcript against this
              agent&apos;s criteria as soon as it ends. Criteria are managed in
              the Evaluation tab of the agent page; with none, nothing is
              judged.
            </p>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => router.back()}
        >
          Cancel
        </Button>
      </div>

      {canvasMounted && (
        <SystemPromptCanvas
          open={canvasOpen}
          onOpenChange={setCanvasOpen}
          value={systemPrompt}
          onChange={setSystemPrompt}
          model={model}
        />
      )}
    </form>
  );
}
