"use client";

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { JsonEditor } from "@/components/json-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetFooter } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";

type ToolFormValues = {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  inputSchema: unknown;
  needsApproval: boolean;
};

const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}';

export function ToolForm({
  initial,
  onSuccess,
  onCancel,
}: {
  initial?: ToolFormValues;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const mode = initial ? "edit" : "create";

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [inputSchemaText, setInputSchemaText] = useState(
    initial ? JSON.stringify(initial.inputSchema, null, 2) : DEFAULT_SCHEMA,
  );
  const [needsApproval, setNeedsApproval] = useState(
    initial?.needsApproval ?? false,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let inputSchema: unknown;
    try {
      inputSchema = JSON.parse(inputSchemaText);
    } catch {
      setError("The input schema must be valid JSON.");
      return;
    }

    setPending(true);
    const body = { name, description, endpoint, inputSchema, needsApproval };
    try {
      if (mode === "create") {
        await apiRequest("/api/tools", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("Tool created.");
      } else {
        await apiRequest(`/api/tools/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Tool updated.");
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
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="endpoint">Endpoint</Label>
          <Input
            id="endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://example.com/api/tool"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Input schema (JSON)</Label>
          <JsonEditor value={inputSchemaText} onChange={setInputSchemaText} />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="needsApproval"
            checked={needsApproval}
            onCheckedChange={setNeedsApproval}
          />
          <Label htmlFor="needsApproval">Requires approval</Label>
        </div>
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
