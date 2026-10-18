"use client";

import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import {
  type ScheduleAgentOption,
  ScheduleForm,
  type ScheduleFormValues,
} from "@/components/forms/schedule-form";
import {
  LIST_SHELL_CLASS,
  LIST_TABLE_CLASS,
  ListSearch,
} from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { RunScheduleButton } from "@/components/run-schedule-button";
import {
  OccurrenceStatusBadge,
  ScheduleStateBadge,
} from "@/components/schedule-badges";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInZone } from "@/lib/format";
import type { ScheduleListRow } from "@/lib/queries-schedules";
import { describeTrigger } from "@/lib/scheduler/calendar";
import { useListFilter } from "@/lib/use-list-filter";

const SCHEDULER_STALE_SECONDS = 90;

export function ScheduleSheet({
  open,
  onOpenChange,
  initial,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ScheduleFormValues;
  agents: ScheduleAgentOption[];
}) {
  const router = useRouter();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{initial ? "Edit schedule" : "New schedule"}</SheetTitle>
        </SheetHeader>
        {open && (
          <ScheduleForm
            initial={initial}
            agents={agents}
            onSuccess={() => {
              onOpenChange(false);
              router.refresh();
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

export function SchedulerStatus({ secondsAgo }: { secondsAgo: number | null }) {
  if (secondsAgo !== null && secondsAgo < SCHEDULER_STALE_SECONDS)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" />
        Scheduler running · last tick {secondsAgo} s ago
      </p>
    );
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>No scheduler is running</AlertTitle>
      <AlertDescription>
        {secondsAgo === null
          ? "No scheduler has ticked yet."
          : `The last tick was ${Math.round(secondsAgo / 60)} min ago.`}{" "}
        Schedules fire only while the app runs with the scheduler on (
        <span className="font-mono">SCHEDULER_ENABLED</span> unset or true). Run
        now still works.
      </AlertDescription>
    </Alert>
  );
}

export function SchedulesList({
  schedules,
  agents,
  schedulerSecondsAgo,
}: {
  schedules: ScheduleListRow[];
  agents: ScheduleAgentOption[];
  schedulerSecondsAgo: number | null;
}) {
  const [creating, setCreating] = useState(false);
  const { query, setQuery, filtered } = useListFilter(
    schedules,
    (schedule) => `${schedule.name} ${schedule.agentName}`,
  );

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow="Workshop · schedules"
        title="Schedules"
        description="Run an agent on its own, on a repeating trigger."
        action={
          <Button onClick={() => setCreating(true)} disabled={!agents.length}>
            New schedule
          </Button>
        }
      />
      <SchedulerStatus secondsAgo={schedulerSecondsAgo} />
      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description={
            agents.length
              ? "A schedule sends a message to an agent on a repeating trigger and records the run."
              : "Create an agent first: a schedule runs one."
          }
          action={
            agents.length ? (
              <Button onClick={() => setCreating(true)}>Create schedule</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder="Search by name or agent…"
            filtered={filtered.length}
            total={schedules.length}
          />
          <Table containerClassName={LIST_TABLE_CLASS}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last result</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell>
                    <Link
                      href={`/schedules/${schedule.id}`}
                      className="font-medium hover:underline"
                    >
                      {schedule.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {schedule.agentName}
                  </TableCell>
                  <TableCell>
                    {describeTrigger(schedule)}
                    <span className="block font-mono text-[11px] text-faint">
                      {schedule.timezone}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {schedule.nextRunAt
                      ? formatInZone(schedule.nextRunAt, schedule.timezone)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {schedule.lastOccurrence ? (
                      <OccurrenceStatusBadge
                        status={schedule.lastOccurrence.status}
                      />
                    ) : (
                      <span className="text-muted-foreground">never ran</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ScheduleStateBadge
                      isActive={schedule.isActive}
                      pausedReason={schedule.pausedReason}
                    />
                    {!schedule.isActive && schedule.pausedReason && (
                      <span className="block max-w-48 text-[11px] text-muted-foreground">
                        {schedule.pausedReason}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <RunScheduleButton scheduleId={schedule.id} size="sm" />
                      <ToggleActiveButton
                        endpoint={`/api/schedules/${schedule.id}`}
                        isActive={schedule.isActive}
                        size="sm"
                      />
                      <DeleteResourceButton
                        endpoint={`/api/schedules/${schedule.id}`}
                        resourceLabel="the schedule"
                        redirectTo="/schedules"
                        size="sm"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <ScheduleSheet
        open={creating}
        onOpenChange={setCreating}
        agents={agents}
      />
    </div>
  );
}

export function EditScheduleButton({
  schedule,
  agents,
}: {
  schedule: ScheduleFormValues;
  agents: ScheduleAgentOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <ScheduleSheet
        open={open}
        onOpenChange={setOpen}
        initial={schedule}
        agents={agents}
      />
    </>
  );
}
