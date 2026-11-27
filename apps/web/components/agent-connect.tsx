"use client";

import { agentAskToolName } from "@agentlathe/db/naming";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

function CopyButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={label}
      title={label}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-primary"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-success" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

function Field({
  label,
  value,
  copyable = true,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-[12.5px]" title={value}>
          {value}
        </span>
        {copyable && <CopyButton value={value} label={`Copy ${label}`} />}
      </dd>
    </>
  );
}

function Code({ label, code }: { label: string; code: string }) {
  return (
    <div className="relative rounded-lg border bg-muted/30">
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={code} label={`Copy ${label}`} />
      </div>
      <pre className="overflow-x-auto p-3 pr-9 font-mono text-[12px] leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5">
      <header>
        <h2 className="text-[13.5px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {description}
        </p>
      </header>
      {children}
    </section>
  );
}

const FIELDS_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5";

export function AgentConnect({ slug }: { slug: string }) {
  const [origin, setOrigin] = useState("http://localhost:3000");
  const [language, setLanguage] = useState("curl");

  useEffect(() => setOrigin(window.location.origin), []);

  const baseUrl = `${origin}/v1`;
  const mcpUrl = `${origin}/mcp/agents/${slug}`;
  const snippets = [
    {
      id: "curl",
      label: "curl",
      code: `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${slug}",
    "messages": [{ "role": "user", "content": "hi" }]
  }'`,
    },
    {
      id: "python",
      label: "Python",
      code: `from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key="unused")
reply = client.chat.completions.create(
    model="${slug}",
    messages=[{"role": "user", "content": "hi"}],
)
print(reply.choices[0].message.content)`,
    },
    {
      id: "typescript",
      label: "TypeScript",
      code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "unused",
});
const reply = await client.chat.completions.create({
  model: "${slug}",
  messages: [{ role: "user", content: "hi" }],
});
console.log(reply.choices[0].message.content);`,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="OpenAI-compatible API"
          description="The agent is a model on this instance's /v1. Any OpenAI client works once its base URL points here."
        >
          <dl className={FIELDS_CLASS}>
            <Field label="Base URL" value={baseUrl} />
            <Field label="Model" value={slug} />
          </dl>
          <Tabs value={language} onValueChange={setLanguage}>
            <TabsList>
              {snippets.map((snippet) => (
                <TabsTrigger key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="mt-3 grid">
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  role="tabpanel"
                  aria-label={`${snippet.label} example`}
                  aria-hidden={snippet.id !== language}
                  inert={snippet.id !== language}
                  className={cn(
                    "col-start-1 row-start-1 min-w-0 [&>div]:h-full",
                    snippet.id !== language && "invisible",
                  )}
                >
                  <Code
                    label={`${snippet.label} example`}
                    code={snippet.code}
                  />
                </div>
              ))}
            </div>
          </Tabs>
          <p className="text-[12.5px] text-muted-foreground">
            The client sends the whole conversation on every call. Optional
            headers: <span className="font-mono">x-thread-id</span> groups calls
            into a thread, <span className="font-mono">x-subject-id</span> says
            who the run is for, <span className="font-mono">x-memory-key</span>{" "}
            selects a custom-key memory. Tools that need approval are denied
            here.
          </p>
        </Panel>

        <Panel
          title="MCP server"
          description="The agent is also its own MCP server, with one tool that asks it a question."
        >
          <dl className={FIELDS_CLASS}>
            <Field label="Server URL" value={mcpUrl} />
            <Field label="Tool" value={agentAskToolName(slug)} />
            <Field label="Transport" value="Streamable HTTP" copyable={false} />
          </dl>
          <Code
            label="MCP client configuration"
            code={`{
  "mcpServers": {
    "${slug}": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`}
          />
          <p className="text-[12.5px] text-muted-foreground">
            For clients configured with an{" "}
            <span className="font-mono">mcpServers</span> block; others only
            need the server URL. <span className="font-mono">x-subject-id</span>{" "}
            and <span className="font-mono">x-memory-key</span> work as HTTP
            headers. A tool that needs approval asks the client to confirm when
            it supports elicitation, and is denied when it does not.
          </p>
        </Panel>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        Neither endpoint asks for a key: the instance has no authentication of
        its own. Put it behind your reverse proxy before exposing it beyond this
        machine.
      </p>
    </div>
  );
}
