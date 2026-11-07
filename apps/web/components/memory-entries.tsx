"use client";

import {
  MEMORY_ENTRY_MAX_LENGTH,
  type MemoryScope,
  RUN_LABEL_MAX_LENGTH,
} from "@agentlathe/db/constants";
import { PinIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { LIST_TABLE_CLASS } from "@/components/list-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";

export type MemoryEntryRow = {
  id: string;
  shortId: string;
  content: string;
  pinned: boolean;
  updatedAt: Date;
};

export type DeletedMemoryEntryRow = {
  id: string;
  shortId: string;
  content: string;
  versionId: string;
};

type Version = {
  id: string;
  revision: number;
  op: string;
  content: string | null;
  author: string;
  runId: string | null;
  createdAt: string;
};

const day = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

function ContentField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Entry</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        required
      />
      <span
        className={
          value.trim().length > MEMORY_ENTRY_MAX_LENGTH
            ? "text-xs text-destructive"
            : "text-xs text-muted-foreground"
        }
      >
        {value.trim().length} / {MEMORY_ENTRY_MAX_LENGTH} characters. One fact,
        written as a statement, not an order.
      </span>
    </div>
  );
}

export function AddMemoryEntryButton({
  storeId,
  scope,
  partitionKey,
}: {
  storeId: string;
  scope: MemoryScope;
  partitionKey: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(
    scope === "agent_subject" ? (partitionKey ?? "") : "",
  );
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await apiRequest<{ partitionKey: string }>(
        `/api/memory-stores/${storeId}/entries`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            ...(scope === "agent_subject" ? { subjectId: label } : {}),
          }),
        },
      );
      toast.success("Entry added.");
      setOpen(false);
      setContent("");
      router.push(`?memory=${encodeURIComponent(created.partitionKey)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Add entry</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Add an entry</DialogTitle>
              <DialogDescription>
                The agent sees it from its next run.
              </DialogDescription>
            </DialogHeader>
            {scope === "agent_subject" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="memory-entry-label">Subject</Label>
                <Input
                  id="memory-entry-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={RUN_LABEL_MAX_LENGTH}
                  className="font-mono"
                  required
                />
              </div>
            )}
            <ContentField
              id="memory-entry-content"
              value={content}
              onChange={setContent}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditEntryDialog({
  storeId,
  entry,
  onClose,
}: {
  storeId: string;
  entry: MemoryEntryRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [content, setContent] = useState(entry.content);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiRequest(`/api/memory-stores/${storeId}/entries/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      toast.success("Entry updated.");
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit {entry.shortId}</DialogTitle>
            <DialogDescription>
              The previous text stays in the entry's history.
            </DialogDescription>
          </DialogHeader>
          <ContentField
            id="memory-entry-edit"
            value={content}
            onChange={setContent}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const OP_LABEL: Record<string, string> = {
  add: "added",
  update: "edited",
  delete: "deleted",
  compaction: "compacted",
  restore: "restored",
};

function HistoryDialog({
  storeId,
  entry,
  versions,
  onClose,
}: {
  storeId: string;
  entry: { id: string; shortId: string };
  versions: Version[] | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function restore(versionId: string) {
    setPending(versionId);
    try {
      await apiRequest(
        `/api/memory-stores/${storeId}/entries/${entry.id}/restore`,
        { method: "POST", body: JSON.stringify({ versionId }) },
      );
      toast.success(`${entry.shortId} restored.`);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>History of {entry.shortId}</DialogTitle>
          <DialogDescription>
            Newest first. Restoring a version saves it as a new change.
          </DialogDescription>
        </DialogHeader>
        {versions === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ol aria-label="Versions" className="flex flex-col gap-2">
            {versions.map((version, index) => (
              <li
                key={version.id}
                className="flex items-start justify-between gap-3 rounded-lg border p-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-faint">
                    rev {version.revision} ·{" "}
                    {OP_LABEL[version.op] ?? version.op} by {version.author} ·{" "}
                    {day(version.createdAt)}
                    {version.runId && (
                      <>
                        {" · "}
                        <Link
                          href={`/runs/${version.runId}`}
                          className="hover:underline"
                        >
                          run
                        </Link>
                      </>
                    )}
                  </p>
                  {version.content !== null && (
                    <p className="whitespace-pre-wrap">{version.content}</p>
                  )}
                </div>
                {index > 0 && version.content !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => restore(version.id)}
                  >
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MemoryEntriesTable({
  storeId,
  entries,
  deleted,
}: {
  storeId: string;
  entries: MemoryEntryRow[];
  deleted: DeletedMemoryEntryRow[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<MemoryEntryRow | null>(null);
  const [history, setHistoryEntry] = useState<{
    id: string;
    shortId: string;
  } | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  function setHistory(entry: { id: string; shortId: string }) {
    setHistoryEntry(entry);
    setVersions(null);
    apiRequest<Version[]>(
      `/api/memory-stores/${storeId}/entries/${entry.id}/versions`,
    )
      .then(setVersions)
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : "Could not load."),
      );
  }

  async function act(
    entry: { id: string; shortId: string },
    request: Promise<unknown>,
    done: string,
  ) {
    setPending(entry.id);
    try {
      await request;
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setPending(null);
    }
  }

  const endpoint = (entryId: string) =>
    `/api/memory-stores/${storeId}/entries/${entryId}`;

  return (
    <>
      <Table containerClassName={LIST_TABLE_CLASS}>
        <TableHeader>
          <TableRow>
            <TableHead>Id</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="py-8 text-center text-muted-foreground"
              >
                No entries. The agent sees "(empty)".
              </TableCell>
            </TableRow>
          ) : (
            entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-xs">
                  {entry.shortId}
                </TableCell>
                <TableCell className="max-w-xl whitespace-normal">
                  {entry.pinned && (
                    <Badge variant="secondary" className="mr-1.5">
                      <PinIcon />
                      pinned
                    </Badge>
                  )}
                  {entry.content}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {day(entry.updatedAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending === entry.id}
                      onClick={() =>
                        act(
                          entry,
                          apiRequest(endpoint(entry.id), {
                            method: "PATCH",
                            body: JSON.stringify({ pinned: !entry.pinned }),
                          }),
                          entry.pinned ? "Unpinned." : "Pinned.",
                        )
                      }
                    >
                      {entry.pinned ? "Unpin" : "Pin"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(entry)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setHistory(entry)}
                    >
                      History
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pending === entry.id}
                      onClick={() =>
                        act(
                          entry,
                          apiRequest(endpoint(entry.id), { method: "DELETE" }),
                          `${entry.shortId} deleted.`,
                        )
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {deleted.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Deleted entries ({deleted.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {deleted.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-lg border p-2"
              >
                <p className="text-muted-foreground">
                  <span className="mr-2 font-mono text-xs">
                    {entry.shortId}
                  </span>
                  {entry.content}
                </p>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistory(entry)}
                  >
                    History
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending === entry.id}
                    onClick={() =>
                      act(
                        entry,
                        apiRequest(`${endpoint(entry.id)}/restore`, {
                          method: "POST",
                          body: JSON.stringify({ versionId: entry.versionId }),
                        }),
                        `${entry.shortId} restored.`,
                      )
                    }
                  >
                    Restore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <EditEntryDialog
          storeId={storeId}
          entry={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {history && (
        <HistoryDialog
          storeId={storeId}
          entry={history}
          versions={versions}
          onClose={() => setHistoryEntry(null)}
        />
      )}
    </>
  );
}

export type MemoryProposalRow = {
  id: string;
  op: string;
  content: string | null;
  shortId: string | null;
  runId: string | null;
  createdAt: Date;
};

const PROPOSAL_LABEL: Record<string, string> = {
  add: "Add",
  update: "Edit",
  delete: "Delete",
};

export function MemoryProposals({
  storeId,
  proposals,
}: {
  storeId: string;
  proposals: MemoryProposalRow[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function decide(proposal: MemoryProposalRow, approve: boolean) {
    setPending(proposal.id);
    try {
      const result = await apiRequest<{
        status: string;
        reason: string | null;
      }>(`/api/memory-stores/${storeId}/proposals/${proposal.id}`, {
        method: "POST",
        body: JSON.stringify({ approve }),
      });
      if (result.reason) toast.error(result.reason);
      else toast.success(approve ? "Saved to memory." : "Rejected.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decide.");
    } finally {
      setPending(null);
    }
  }

  return (
    <ul aria-label="Proposals" className="flex flex-col gap-2">
      {proposals.map((proposal) => (
        <li
          key={proposal.id}
          className="flex items-start justify-between gap-3 rounded-lg border p-2 text-sm"
        >
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-faint">
              {PROPOSAL_LABEL[proposal.op] ?? proposal.op}
              {proposal.shortId && ` ${proposal.shortId}`} ·{" "}
              {day(proposal.createdAt)}
              {proposal.runId && (
                <>
                  {" · "}
                  <Link
                    href={`/runs/${proposal.runId}`}
                    className="hover:underline"
                  >
                    run
                  </Link>
                </>
              )}
            </p>
            {proposal.content !== null && (
              <p className="whitespace-pre-wrap">{proposal.content}</p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => decide(proposal, false)}
            >
              Reject
            </Button>
            <Button
              size="sm"
              disabled={pending !== null}
              onClick={() => decide(proposal, true)}
            >
              Approve
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
