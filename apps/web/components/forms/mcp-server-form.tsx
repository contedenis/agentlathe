"use client";

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { TestMcpServerButton } from "@/components/forms/test-mcp-server-button";
import { JsonEditor } from "@/components/json-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetFooter } from "@/components/ui/sheet";
import { apiRequest } from "@/lib/mutate";

type McpServerFormValues = {
  id: string;
  name: string;
  serverUrl: string;
  hasAuth: boolean;
  authRefs?: Record<string, string> | null;
};

export function McpServerForm({
  initial,
  onSuccess,
  onCancel,
}: {
  initial?: McpServerFormValues;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const mode = initial ? "edit" : "create";

  const [name, setName] = useState(initial?.name ?? "");
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "");
  const [authConfigText, setAuthConfigText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let authConfigForTest: unknown = null;
  let authConfigInvalid = false;
  if (authConfigText.trim().length > 0) {
    try {
      authConfigForTest = JSON.parse(authConfigText);
    } catch {
      authConfigInvalid = true;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedAuthConfig = authConfigText.trim();
    let authConfig: unknown = null;
    if (trimmedAuthConfig.length > 0) {
      try {
        authConfig = JSON.parse(trimmedAuthConfig);
      } catch {
        setError("The auth config must be valid JSON (or left empty).");
        return;
      }
    }

    setPending(true);
    const body: { name: string; serverUrl: string; authConfig?: unknown } = {
      name,
      serverUrl,
    };
    if (trimmedAuthConfig.length > 0 || mode === "create") {
      body.authConfig = authConfig;
    }
    try {
      if (mode === "create") {
        await apiRequest("/api/mcp-servers", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("MCP server created.");
      } else {
        await apiRequest(`/api/mcp-servers/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("MCP server updated.");
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
          <Label htmlFor="serverUrl">Server URL</Label>
          <Input
            id="serverUrl"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Auth config (JSON, optional)</Label>
          {initial?.hasAuth && (
            <p className="text-xs text-muted-foreground">
              Credentials are already set. Leave it empty to keep them, or paste
              new JSON to replace them.
            </p>
          )}
          {initial?.authRefs && (
            <p className="text-xs text-muted-foreground">
              Env references in the saved config:{" "}
              {Object.entries(initial.authRefs)
                .map(([header, envVar]) => `${header} → ${envVar}`)
                .join(", ")}
            </p>
          )}
          <JsonEditor
            value={authConfigText}
            onChange={setAuthConfigText}
            minHeight="6rem"
            placeholder='{"headers": {"Authorization": "Bearer ..."}}'
          />
          <p className="text-xs text-muted-foreground">
            A header value starting with <code>AGENTLATHE_SECRET_</code> is
            treated as the name of an env var and resolved when connecting —
            only the name is stored.
          </p>
          {authConfigInvalid && (
            <p className="text-xs text-destructive">
              The auth config is not valid JSON — the connection cannot be
              tested until it is fixed.
            </p>
          )}
        </div>
        <TestMcpServerButton
          serverUrl={serverUrl}
          authConfig={authConfigForTest}
          disabled={authConfigInvalid}
          serverId={initial?.id}
          useSavedAuth={
            Boolean(initial?.hasAuth) && authConfigText.trim().length === 0
          }
        />
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
