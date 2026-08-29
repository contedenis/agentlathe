"use client";

import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "@agentlathe/runner/chat-ui";
import { useChat } from "@ai-sdk/react";
import {
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent } from "react";
import { useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { toolPreview } from "@/components/ai-elements/tool";
import { FixDraftChip } from "@/components/fix-draft-chip";
import { FixDraftDialog } from "@/components/fix-draft-dialog";
import { ToolCallDisplay, toolNameOf } from "@/components/tool-call-display";
import {
  AnnotateButton,
  type AnnotateTarget,
} from "@/components/transcript-history";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FixDraft } from "@/lib/fix-drafts";

type PendingApproval = {
  id: string;
  toolName: string;
  preview: string | undefined;
};

function ApprovalBanner({
  approval,
  onApprove,
}: {
  approval: PendingApproval;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/15 px-[15px] py-[13px]">
      <TriangleAlertIcon className="size-5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">
          The agent wants to run a tool that needs your approval
        </p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
          <code className="font-mono text-warning">{approval.toolName}</code>
          {approval.preview ? ` · ${approval.preview}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onApprove(approval.id, false)}
        >
          Deny
        </Button>
        <Button size="sm" onClick={() => onApprove(approval.id, true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

function runIdOf(parts: { type: string }[]): string | undefined {
  for (const part of parts) {
    if (part.type !== "data-run") continue;
    const data = (part as { data?: { runId?: unknown } }).data;
    if (typeof data?.runId === "string") return data.runId;
  }
  return undefined;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
      <span className="flex gap-1">
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current" />
      </span>
      Thinking…
    </div>
  );
}

export function AgentPlayground({ agentId }: { agentId: string }) {
  const [input, setInput] = useState("");
  const [annotate, setAnnotate] = useState<{
    runId: string;
    target: AnnotateTarget;
  } | null>(null);
  const [notes, setNotes] = useState<Array<{ runId: string; draft: FixDraft }>>(
    [],
  );
  const [editing, setEditing] = useState<{
    runId: string;
    draft: FixDraft;
  } | null>(null);
  const threadIdRef = useRef<string | undefined>(undefined);

  const {
    messages,
    sendMessage,
    addToolApprovalResponse,
    status,
    error,
    stop,
    regenerate,
  } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/agents/${agentId}/chat`,
      body: () => ({ threadId: threadIdRef.current }),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const threadId = response.headers.get("x-thread-id");
        if (threadId) threadIdRef.current = threadId;
        return response;
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const canRegenerate = !isBusy && lastMessage?.role === "assistant";

  const pendingApprovals: PendingApproval[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") {
        pendingApprovals.push({
          id: part.approval.id,
          toolName: toolNameOf(part),
          preview: toolPreview(part),
        });
      }
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function handleApprove(approvalId: string, approved: boolean) {
    addToolApprovalResponse({ id: approvalId, approved });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 rounded-xl border bg-card p-3">
      {pendingApprovals.length > 0 && (
        <div className="flex flex-col gap-2" aria-live="polite">
          {pendingApprovals.map((approval) => (
            <ApprovalBanner
              key={approval.id}
              approval={approval}
              onApprove={handleApprove}
            />
          ))}
        </div>
      )}

      <Conversation>
        <ConversationContent>
          {messages.length === 0 && (
            <ConversationEmptyState description="Write a message to start chatting with the agent." />
          )}
          {messages.map((message) => {
            const runId = runIdOf(message.parts);
            const messageNotes = notes.filter(
              (note) => note.draft.messageId === message.id,
            );
            return (
              <div key={message.id} className="flex flex-col gap-1.5">
                <Message from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, index) =>
                      part.type === "text" ? (
                        <Response key={`${message.id}-${index}`}>
                          {part.text}
                        </Response>
                      ) : (
                        <ToolCallDisplay
                          key={
                            isToolUIPart(part)
                              ? part.toolCallId
                              : `${message.id}-${index}`
                          }
                          part={part}
                        />
                      ),
                    )}
                  </MessageContent>
                </Message>
                {runId && (
                  <div className="flex items-center gap-2">
                    <AnnotateButton
                      label="Turn"
                      onClick={() =>
                        setAnnotate({
                          runId,
                          target: {
                            messageId: message.id,
                            anchor: { type: "turn" },
                            label: "Assistant turn",
                          },
                        })
                      }
                    />
                    <Link
                      href={`/runs/${runId}`}
                      className="text-[11px] text-muted-foreground hover:text-primary hover:underline"
                    >
                      Open run
                    </Link>
                  </div>
                )}
                {messageNotes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {messageNotes.map((note) => (
                      <FixDraftChip
                        key={note.draft.id}
                        draft={note.draft}
                        onClick={() => setEditing(note)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {status === "submitted" && <ThinkingIndicator />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        {canRegenerate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => regenerate()}
            className="self-start text-muted-foreground"
          >
            <RotateCcwIcon />
            Regenerate
          </Button>
        )}
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a message (Enter sends, Shift+Enter adds a line break)"
            className="max-h-[200px] min-h-[56px] flex-1 resize-none"
          />
          {isBusy ? (
            <Button
              onClick={() => stop()}
              size="icon"
              variant="outline"
              className="size-14 shrink-0"
              aria-label="Stop"
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              disabled={input.trim() === ""}
              size="icon"
              className="size-14 shrink-0"
              aria-label="Send"
            >
              <SendIcon />
            </Button>
          )}
        </div>
      </div>

      <FixDraftDialog
        endpoint={`/api/runs/${editing?.runId ?? annotate?.runId}/fix-drafts`}
        target={annotate?.target ?? null}
        editing={editing?.draft ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setAnnotate(null);
            setEditing(null);
          }
        }}
        onCreated={(draft) => {
          if (annotate)
            setNotes((current) => [
              ...current,
              { runId: annotate.runId, draft },
            ]);
          setAnnotate(null);
        }}
        onUpdated={(draft) => {
          setNotes((current) =>
            current.map((note) =>
              note.draft.id === draft.id ? { ...note, draft } : note,
            ),
          );
          setEditing(null);
        }}
      />
    </div>
  );
}
