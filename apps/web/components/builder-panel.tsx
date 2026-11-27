"use client";

import {
  DefaultChatTransport,
  isToolUIPart,
  type UIMessage,
} from "@agentlathe/runner/chat-ui";
import { useChat } from "@ai-sdk/react";
import { PlusIcon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import {
  CriterionDialog,
  type CriterionDraft,
} from "@/components/criterion-dialog";
import type { AgentFormValues } from "@/components/forms/agent-form";
import type { ScheduleDraft } from "@/components/forms/schedule-form";
import { SkillForm, type SkillFormValues } from "@/components/forms/skill-form";
import { ScheduleSheet } from "@/components/schedules-list";
import { toolNameOf } from "@/components/tool-call-display";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentChanges,
  type AgentDraft,
  type AgentProposal,
  type CriterionProposal,
  proposalToDraft,
  type ScheduleProposal,
  type SkillProposal,
  skillProposalBody,
} from "@/lib/builder/proposal";
import { diffText } from "@/lib/version-diff";

type MessagePart = UIMessage["parts"][number];

export type AddressedNote = { id: string; runId: string };

const LOOKUP_LABEL: Record<string, string> = {
  search_models: "Searched the model catalog",
  list_mcp_tools: "Listed an MCP server's tools",
  get_agent_review: "Read the open notes and verdicts",
  get_run_transcript: "Read a run",
};

function storedMessages(key: string): UIMessage[] {
  try {
    const stored = window.sessionStorage.getItem(key);
    return stored ? (JSON.parse(stored) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function count(items: unknown[], noun: string): string | null {
  if (items.length === 0) return null;
  return `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
}

function ProposalCard({
  kind,
  title,
  action,
  onAction,
  children,
}: {
  kind: string;
  title: string;
  action: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`${kind} ${title}`}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-[12.5px]"
    >
      <header>
        <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
          {kind}
        </p>
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
      </header>
      {children}
      <Button size="sm" className="self-start" onClick={onAction}>
        {action}
      </Button>
    </section>
  );
}

const Rationale = ({ children }: { children: string }) => (
  <p className="whitespace-pre-wrap text-muted-foreground">{children}</p>
);

function attachedSummary(proposal: AgentProposal | AgentChanges): string {
  const attached = [
    count(proposal.skillIds, "skill"),
    count(proposal.toolIds, "HTTP tool"),
    count(proposal.mcpTools, "MCP tool"),
    count(proposal.subAgentIds, "sub-agent"),
    count(proposal.knowledge, "knowledge collection"),
    proposal.memory.type === "none" ? null : "memory",
  ].filter(Boolean);
  return attached.length > 0
    ? attached.join(" · ")
    : "Nothing attached: prompt and model only.";
}

const sameSet = (a: unknown[], b: unknown[]) =>
  JSON.stringify(a.map((item) => JSON.stringify(item)).sort()) ===
  JSON.stringify(b.map((item) => JSON.stringify(item)).sort());

export function changedFields(
  current: Omit<AgentFormValues, "id">,
  draft: AgentDraft,
): string[] {
  const changed: string[] = [];
  const scalar = (
    label: string,
    before: unknown,
    after: unknown,
    showValues = false,
  ) => {
    if (after === undefined || (before ?? "") === (after ?? "")) return;
    changed.push(showValues ? `${label} ${before} → ${after}` : label);
  };
  scalar("name", current.name, draft.name, true);
  scalar("description", current.description, draft.description);
  scalar("model", current.model, draft.model, true);
  scalar("max steps", current.maxSteps, draft.maxSteps, true);
  if (draft.systemPrompt !== undefined) {
    const lines = diffText(
      current.systemPrompt ?? "",
      draft.systemPrompt ?? "",
    ).flat();
    const added = lines.filter((line) => line.kind === "added").length;
    const removed = lines.filter((line) => line.kind === "removed").length;
    if (added + removed > 0)
      changed.push(`system prompt (+${added} −${removed} lines)`);
  }
  const lists: Array<[string, unknown[], unknown[] | undefined]> = [
    ["skills", current.skillIds, draft.skillIds],
    ["HTTP tools", current.toolIds, draft.toolIds],
    ["sub-agents", current.subAgentIds, draft.subAgentIds],
    ["MCP tools", current.mcpTools, draft.mcpTools],
    ["knowledge", current.knowledge, draft.knowledge],
  ];
  for (const [label, before, after] of lists) {
    if (!after || sameSet(before, after)) continue;
    const key = (item: unknown) =>
      JSON.stringify(
        item && typeof item === "object"
          ? { ...item, needsApproval: undefined, mode: undefined }
          : item,
      );
    const had = new Set(before.map(key));
    const has = new Set(after.map(key));
    const added = [...has].filter((item) => !had.has(item)).length;
    const removed = [...had].filter((item) => !has.has(item)).length;
    changed.push(
      added + removed > 0 ? `${label} (+${added} −${removed})` : label,
    );
  }
  for (const tool of draft.mcpTools ?? [])
    if (
      !tool.needsApproval &&
      current.mcpTools.some(
        (before) =>
          before.serverId === tool.serverId &&
          before.toolName === tool.toolName &&
          before.needsApproval,
      )
    )
      changed.push(`approval removed from ${tool.toolName}`);
  if (draft.memory) {
    const { memory } = draft;
    if (memory.type !== current.memory.type)
      changed.push(`memory ${current.memory.type} → ${memory.type}`);
    else if (
      memory.type !== "none" &&
      (JSON.stringify(memory.settings[memory.type]) !==
        JSON.stringify(current.memory.settings[memory.type]) ||
        (memory.type === "custom" &&
          memory.memoryKey !== current.memory.memoryKey))
    )
      changed.push("memory settings");
  }
  return changed;
}

type OpenForm =
  | { kind: "skill"; draft: Omit<SkillFormValues, "id"> }
  | { kind: "schedule"; draft: ScheduleDraft }
  | { kind: "criterion"; draft: CriterionDraft };

export function BuilderPanel({
  open,
  onOpenChange,
  configured,
  storageKey,
  agent,
  onLoadAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configured: boolean;
  storageKey: string;
  agent?: { id: string; name: string; current: Omit<AgentFormValues, "id"> };
  onLoadAgent: (draft: AgentDraft, notes: AddressedNote[]) => boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [form, setForm] = useState<OpenForm | null>(null);
  const agentIdRef = useRef(agent?.id);
  agentIdRef.current = agent?.id;
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    error,
    clearError,
    stop,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/builder/chat",
      body: () => ({ agentId: agentIdRef.current }),
    }),
  });
  const isBusy = status === "submitted" || status === "streaming";

  const [restoredKey, setRestoredKey] = useState<string | null>(null);

  useEffect(() => {
    setMessages(storedMessages(storageKey));
    setRestoredKey(storageKey);
  }, [storageKey, setMessages]);

  useEffect(() => {
    if (isBusy || restoredKey !== storageKey) return;
    window.sessionStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages, isBusy, storageKey, restoredKey]);

  function handleSend() {
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function loadAgent(draft: AgentDraft, notes: AddressedNote[] = []) {
    if (onLoadAgent(draft, notes)) onOpenChange(false);
  }

  function renderProposal(part: MessagePart, name: string, key: string) {
    if (!isToolUIPart(part) || part.state !== "output-available") return null;
    if (name === "propose_agent") {
      const proposal = part.input as AgentProposal;
      return (
        <ProposalCard
          key={key}
          kind="Proposed agent"
          title={proposal.name}
          action="Load into form"
          onAction={() => loadAgent(proposalToDraft(proposal))}
        >
          <p className="text-muted-foreground">{proposal.description}</p>
          <p className="font-mono text-[12px]">{proposal.model}</p>
          <p>{attachedSummary(proposal)}</p>
          <Rationale>{proposal.rationale}</Rationale>
          {proposal.missing.length > 0 && (
            <div>
              <p className="font-medium">Not in this instance yet</p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {proposal.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </ProposalCard>
      );
    }
    if (name === "propose_agent_changes" && agent) {
      const proposal = part.input as AgentChanges;
      const draft = proposalToDraft(proposal, agent.current.memory);
      const changed = changedFields(agent.current, draft);
      const notes =
        (part.output as { notes?: AddressedNote[] } | undefined)?.notes ?? [];
      return (
        <ProposalCard
          key={key}
          kind="Proposed changes"
          title={agent.name}
          action="Load into form"
          onAction={() => loadAgent(draft, notes)}
        >
          <p>
            {changed.length > 0
              ? `Changes: ${changed.join(" · ")}`
              : "Nothing differs from the saved configuration."}
          </p>
          {notes.length > 0 && (
            <p>
              Answers {notes.length} open{" "}
              {notes.length === 1 ? "note" : "notes"}.
            </p>
          )}
          <Rationale>{proposal.rationale}</Rationale>
        </ProposalCard>
      );
    }
    if (name === "propose_skill") {
      const proposal = part.input as SkillProposal;
      return (
        <ProposalCard
          key={key}
          kind="Proposed skill"
          title={proposal.name}
          action="Open in form"
          onAction={() =>
            setForm({ kind: "skill", draft: skillProposalBody(proposal) })
          }
        >
          <p className="text-muted-foreground">{proposal.description}</p>
          {proposal.script && <p>Runs a script.</p>}
          <Rationale>{proposal.rationale}</Rationale>
        </ProposalCard>
      );
    }
    if (name === "propose_schedule" && agent) {
      const proposal = part.input as ScheduleProposal;
      return (
        <ProposalCard
          key={key}
          kind="Proposed schedule"
          title={proposal.name}
          action="Open in form"
          onAction={() =>
            setForm({
              kind: "schedule",
              draft: {
                agentId: agent.id,
                name: proposal.name,
                frequency: proposal.frequency,
                timeOfDay: proposal.timeOfDay,
                ...(proposal.weekday !== undefined
                  ? { weekday: proposal.weekday }
                  : {}),
                ...(proposal.startDate
                  ? { startDate: proposal.startDate }
                  : {}),
                input: proposal.input,
              },
            })
          }
        >
          <p>
            {proposal.frequency} at {proposal.timeOfDay}
          </p>
          <Rationale>{proposal.rationale}</Rationale>
        </ProposalCard>
      );
    }
    if (name === "propose_criterion" && agent) {
      const proposal = part.input as CriterionProposal;
      return (
        <ProposalCard
          key={key}
          kind="Proposed criterion"
          title={proposal.question}
          action="Open in form"
          onAction={() => setForm({ kind: "criterion", draft: proposal })}
        >
          <Rationale>{proposal.rationale}</Rationale>
        </ProposalCard>
      );
    }
    return null;
  }

  function renderPart(part: MessagePart, key: string) {
    if (part.type === "text") return <Response key={key}>{part.text}</Response>;
    if (!isToolUIPart(part)) return null;
    const name = toolNameOf(part);
    if (name.startsWith("propose_")) return renderProposal(part, name, key);
    if (part.state !== "output-available") return null;
    return (
      <p key={key} className="text-[12px] text-muted-foreground">
        {LOOKUP_LABEL[name] ?? name}
      </p>
    );
  }

  const closeForm = () => setForm(null);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="gap-0 p-0"
          style={{ width: "min(560px, 100vw)", maxWidth: "100vw" }}
        >
          <div className="flex items-center gap-3 border-b p-4">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                Agent · builder
              </p>
              <SheetTitle>Builder</SheetTitle>
            </div>
            {messages.length > 0 && !isBusy && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setMessages([]);
                  clearError();
                }}
              >
                <PlusIcon />
                New conversation
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close the builder"
              onClick={() => onOpenChange(false)}
            >
              <XIcon />
            </Button>
          </div>

          {configured ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
              <Conversation>
                <ConversationContent>
                  {messages.length === 0 && (
                    <ConversationEmptyState
                      description={
                        agent
                          ? `Ask for a change to ${agent.name}, a schedule or criteria for it, or to improve it from the notes and verdicts on its runs.`
                          : "Say what the agent is for. The builder knows this instance's tools, skills, MCP servers, knowledge and agents, and proposes a configuration you load into the form."
                      }
                    />
                  )}
                  {messages.map((message) => (
                    <Message key={message.id} from={message.role}>
                      <MessageContent>
                        {message.parts.map((part, index) =>
                          renderPart(part, `${message.id}-${index}`),
                        )}
                      </MessageContent>
                    </Message>
                  ))}
                  {isBusy && (
                    <p
                      className="text-[12px] text-muted-foreground"
                      aria-live="polite"
                    >
                      Working…
                    </p>
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              )}

              <div className="flex items-end gap-2">
                <Textarea
                  aria-label="Message to the builder"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    agent
                      ? "Improve it from the open notes on its runs…"
                      : "An agent that triages support tickets and drafts a reply…"
                  }
                  rows={2}
                  className="min-h-0 flex-1 resize-none"
                />
                {isBusy ? (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Stop"
                    onClick={() => stop()}
                  >
                    <SquareIcon />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    aria-label="Send"
                    disabled={!input.trim()}
                    onClick={handleSend}
                  >
                    <SendIcon />
                  </Button>
                )}
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {agent
                  ? "This agent's configuration, and the notes, verdicts and runs the builder reads, are sent to the builder's model with the names and descriptions of what this instance has."
                  : "Names and descriptions of what this instance has are sent to the builder's model."}{" "}
                Conversations are not recorded.
              </p>
            </div>
          ) : (
            <div className="p-4 text-sm">
              <p>The builder needs a model to think with.</p>
              <Link href="/settings" className="text-primary hover:underline">
                Choose a builder model in Settings
              </Link>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Sheet
        open={form?.kind === "skill"}
        onOpenChange={(next) => !next && closeForm()}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New skill</SheetTitle>
          </SheetHeader>
          {form?.kind === "skill" && (
            <SkillForm
              draft={form.draft}
              onSuccess={() => {
                closeForm();
                router.refresh();
              }}
              onCancel={closeForm}
            />
          )}
        </SheetContent>
      </Sheet>
      {agent && (
        <>
          <ScheduleSheet
            open={form?.kind === "schedule"}
            onOpenChange={(next) => !next && closeForm()}
            draft={form?.kind === "schedule" ? form.draft : undefined}
            agents={[{ id: agent.id, name: agent.name }]}
          />
          <CriterionDialog
            agentId={agent.id}
            open={form?.kind === "criterion"}
            onOpenChange={(next) => !next && closeForm()}
            draft={form?.kind === "criterion" ? form.draft : null}
          />
        </>
      )}
    </>
  );
}
