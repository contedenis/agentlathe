"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  DiffLine,
  EntityChange,
  EntityKind,
  FieldChange,
  VersionChanges,
  VersionSnapshot,
} from "@/lib/version-diff";

const KIND_TITLE: Record<EntityKind, string> = {
  skill: "Skills",
  tool: "HTTP tools",
  mcp: "MCP servers",
  sub_agent: "Sub-agents",
};

const STATUS_LABEL: Record<EntityChange["status"], string> = {
  added: "added",
  removed: "removed",
  changed: "edited",
};

const STATUS_CLASS: Record<EntityChange["status"], string> = {
  added: "bg-success/15 text-success",
  removed: "bg-destructive/15 text-destructive",
  changed: "bg-warning/15 text-warning",
};

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-muted-foreground",
  added: "bg-success/15",
  removed: "bg-destructive/15",
};

const LINE_PREFIX: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "−",
};

function Hunks({ hunks }: { hunks: DiffLine[][] }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-muted/30 py-1 font-mono text-xs">
      {hunks.map((hunk, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no identity beyond their order
        <div key={index}>
          {index > 0 && (
            <div className="px-2 text-muted-foreground select-none">⋯</div>
          )}
          {hunk.map((line, lineIndex) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their order
              key={lineIndex}
              className={cn("px-2 whitespace-pre-wrap", LINE_CLASS[line.kind])}
            >
              <span aria-hidden className="mr-2 select-none">
                {LINE_PREFIX[line.kind]}
              </span>
              {line.text || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Field({ field }: { field: FieldChange }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-muted-foreground">
        {field.label}
      </div>
      {field.kind === "text" && <Hunks hunks={field.hunks} />}
      {field.kind === "note" && (
        <p className="text-xs text-muted-foreground">{field.text}</p>
      )}
      {field.kind === "value" && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
          {field.from !== null && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                field.to !== null && "bg-destructive/15 line-through",
              )}
            >
              {field.from}
            </span>
          )}
          {field.from !== null && field.to !== null && (
            <span aria-hidden>→</span>
          )}
          {field.to !== null && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                field.from !== null && "bg-success/15",
              )}
            >
              {field.to}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function VersionChangesDialog({
  shortHash,
  previousShortHash,
  changes,
}: {
  shortHash: string;
  previousShortHash: string;
  changes: VersionChanges;
}) {
  const kinds = (Object.keys(KIND_TITLE) as EntityKind[]).filter((kind) =>
    changes.entities.some((entity) => entity.kind === kind),
  );
  const empty = changes.agent.length === 0 && kinds.length === 0;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-[11px] font-normal"
          />
        }
      >
        What changed
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Changes in <span className="font-mono">{shortHash}</span>
          </DialogTitle>
          <DialogDescription>
            Compared with <span className="font-mono">{previousShortHash}</span>
            , the version before it in this table.
          </DialogDescription>
        </DialogHeader>
        {empty && (
          <p className="text-sm text-muted-foreground">
            Nothing that can be shown changed. The versions differ in something
            the snapshot does not keep in full, such as a part of a URL that is
            stored only as a digest.
          </p>
        )}
        {changes.agent.length > 0 && (
          <Section title="Agent">
            {changes.agent.map((field) => (
              <Field key={field.label} field={field} />
            ))}
          </Section>
        )}
        {kinds.map((kind) => (
          <Section key={kind} title={KIND_TITLE[kind]}>
            {changes.entities
              .filter((entity) => entity.kind === kind)
              .map((entity) => (
                <div
                  key={entity.name}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{entity.name}</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[10px]",
                        STATUS_CLASS[entity.status],
                      )}
                    >
                      {STATUS_LABEL[entity.status]}
                    </span>
                  </div>
                  {entity.fields.map((field) => (
                    <Field key={field.label} field={field} />
                  ))}
                </div>
              ))}
          </Section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

function Text({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function Card({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="font-medium">{name}</span>
      {children}
    </div>
  );
}

export function VersionConfigDialog({
  shortHash,
  config,
}: {
  shortHash: string;
  config: VersionSnapshot;
}) {
  return (
    <Dialog>
      <DialogTrigger
        title="Agent version: open the configuration this run used"
        className="cursor-pointer font-mono underline decoration-dotted underline-offset-4 hover:text-foreground"
      >
        {shortHash}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Agent version <span className="font-mono">{shortHash}</span>
          </DialogTitle>
          <DialogDescription>
            The configuration this run started with. MCP auth headers are never
            stored, and of each URL only scheme and host are readable.
          </DialogDescription>
        </DialogHeader>
        <Section title="Agent">
          <Item label="Model">
            <span className="font-mono text-xs">{config.model}</span>
          </Item>
          <Item label="Max steps">
            <span className="font-mono text-xs">{config.maxSteps}</span>
          </Item>
          <Item label="System prompt">
            {config.systemPrompt ? (
              <Text>{config.systemPrompt}</Text>
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
          </Item>
        </Section>
        {config.skills.length > 0 && (
          <Section title={KIND_TITLE.skill}>
            {config.skills.map((skill) => (
              <Card key={skill.name} name={skill.name}>
                <Item label="Description">
                  <span className="text-xs">{skill.description}</span>
                </Item>
                <Item label="Content">
                  <Text>{skill.content}</Text>
                </Item>
              </Card>
            ))}
          </Section>
        )}
        {config.httpTools.length > 0 && (
          <Section title={KIND_TITLE.tool}>
            {config.httpTools.map((tool) => (
              <Card key={tool.name} name={tool.name}>
                <Item label="Description">
                  <span className="text-xs">{tool.description}</span>
                </Item>
                <Item label="Endpoint">
                  <span className="font-mono text-xs break-all">
                    {tool.endpoint}
                  </span>
                </Item>
                <Item label="Requires approval">
                  <span className="text-xs">
                    {tool.needsApproval ? "yes" : "no"}
                  </span>
                </Item>
                <Item label="Input schema">
                  <Text>{JSON.stringify(tool.inputSchema, null, 2)}</Text>
                </Item>
              </Card>
            ))}
          </Section>
        )}
        {config.mcpServers.length > 0 && (
          <Section title={KIND_TITLE.mcp}>
            {config.mcpServers.map((server) => (
              <Card key={server.name} name={server.name}>
                <Item label="Server URL">
                  <span className="font-mono text-xs break-all">
                    {server.serverUrl}
                  </span>
                </Item>
                <Item label="Selected tools">
                  <span className="font-mono text-xs">
                    {server.toolNames
                      .map((name) =>
                        server.approvalToolNames.includes(name)
                          ? `${name} (requires approval)`
                          : name,
                      )
                      .join(", ") || "None"}
                  </span>
                </Item>
              </Card>
            ))}
          </Section>
        )}
        {config.subAgents.length > 0 && (
          <Section title={KIND_TITLE.sub_agent}>
            {config.subAgents.map((child) => (
              <Card key={child.slug} name={child.slug}>
                <Item label="Description the parent sees">
                  <span className="text-xs">{child.description}</span>
                </Item>
              </Card>
            ))}
          </Section>
        )}
      </DialogContent>
    </Dialog>
  );
}
