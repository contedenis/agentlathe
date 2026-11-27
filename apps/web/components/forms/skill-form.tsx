"use client";

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { JsonEditor } from "@/components/json-editor";
import { ScriptEditor } from "@/components/script-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetFooter } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";

export type SkillFormValues = {
  id: string;
  name: string;
  description: string;
  content: string;
  script?: string | null;
  inputSchema?: unknown;
  needsApproval?: boolean;
};

type TestRun =
  | { ok: true; result: unknown; logs: string[]; durationMs: number }
  | { ok: false; error: string; logs: string[]; durationMs: number };

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function SkillForm({
  initial,
  draft,
  onSuccess,
  onCancel,
}: {
  initial?: SkillFormValues;
  draft?: Omit<SkillFormValues, "id">;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const mode = initial ? "edit" : "create";
  const start = initial ?? draft;

  const [name, setName] = useState(start?.name ?? "");
  const [description, setDescription] = useState(start?.description ?? "");
  const [content, setContent] = useState(start?.content ?? "");
  const [script, setScript] = useState(start?.script ?? "");
  const [inputSchema, setInputSchema] = useState(
    start?.inputSchema ? JSON.stringify(start.inputSchema, null, 2) : "",
  );
  const [needsApproval, setNeedsApproval] = useState(
    start?.needsApproval ?? false,
  );
  const [testInput, setTestInput] = useState("{}");
  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasScript = script.trim() !== "";

  async function handleTest() {
    setError(null);
    setTesting(true);
    try {
      setTestRun(
        await apiRequest<TestRun>("/api/skills/test-run", {
          method: "POST",
          body: JSON.stringify({
            script,
            input: parseJson(testInput, "The test input"),
          }),
        }),
      );
    } catch (err) {
      setTestRun(null);
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body = {
        name,
        description,
        content,
        script: hasScript ? script : null,
        inputSchema:
          hasScript && inputSchema.trim() !== ""
            ? parseJson(inputSchema, "The input schema")
            : null,
        needsApproval: hasScript && needsApproval,
      };
      if (mode === "create") {
        await apiRequest("/api/skills", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("Skill created.");
      } else {
        await apiRequest(`/api/skills/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Skill updated.");
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Always injected into the agent's system prompt. The full content is
            loaded on demand with the `load_skill` tool.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="content">Content</Label>
          <Textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Script (optional)</Label>
          <ScriptEditor
            value={script}
            onChange={setScript}
            placeholder={
              "// input is the tool's input\nreturn { total: input.a + input.b };"
            }
          />
          <p className="text-xs text-muted-foreground">
            JavaScript the agent can run as a tool of its own. It gets the
            tool's input as `input` and returns a JSON value, without `async` or
            `await`. It runs in a sandbox: no network, no files, no packages,
            two seconds and 64 MB at most.
          </p>
        </div>
        {hasScript && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label>Input schema (optional)</Label>
              <JsonEditor
                value={inputSchema}
                onChange={setInputSchema}
                minHeight="5rem"
                placeholder='{ "type": "object", "properties": {} }'
              />
              <p className="text-xs text-muted-foreground">
                JSON Schema of the input. Without one the script takes any
                object.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="needsApproval"
                checked={needsApproval}
                onCheckedChange={setNeedsApproval}
              />
              <Label htmlFor="needsApproval">
                Requires approval before running
              </Label>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border p-3">
              <Label htmlFor="testInput">Test run</Label>
              <Textarea
                id="testInput"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                rows={3}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={testing}
                onClick={handleTest}
              >
                {testing ? "Running..." : "Run script"}
              </Button>
              {testRun && (
                <div className="flex flex-col gap-1" aria-live="polite">
                  <p
                    className={
                      testRun.ok
                        ? "text-xs text-muted-foreground"
                        : "text-xs text-destructive"
                    }
                  >
                    {testRun.ok ? "Returned" : "Failed"} in {testRun.durationMs}{" "}
                    ms
                  </p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 font-mono text-xs">
                    {testRun.ok
                      ? JSON.stringify(testRun.result, null, 2)
                      : testRun.error}
                  </pre>
                  {testRun.logs.length > 0 && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
                      {testRun.logs.join("\n")}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}
