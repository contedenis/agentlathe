import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import { LIST_TABLE_CLASS } from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { RunScheduleButton } from "@/components/run-schedule-button";
import {
  OccurrenceStatusBadge,
  ScheduleStateBadge,
} from "@/components/schedule-badges";
import { EditScheduleButton } from "@/components/schedules-list";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInZone } from "@/lib/format";
import { listAgents } from "@/lib/queries";
import { getScheduleDetail } from "@/lib/queries-schedules";
import { describeTrigger } from "@/lib/scheduler/calendar";

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [schedule, agents] = await Promise.all([
    getScheduleDetail(id),
    listAgents(),
  ]);
  if (!schedule) notFound();

  return (
    <div className="flex flex-col gap-4">
      <BreadcrumbTitle name={schedule.name} />
      <PageHeader
        eyebrow="Schedule · detail"
        title={schedule.name}
        description={`${describeTrigger(schedule)} · ${schedule.timezone}`}
        action={
          <ScheduleStateBadge
            isActive={schedule.isActive}
            pausedReason={schedule.pausedReason}
          />
        }
      />

      <div className="flex flex-wrap gap-2">
        <RunScheduleButton scheduleId={schedule.id} />
        <EditScheduleButton
          schedule={schedule}
          agents={agents.map(({ id: agentId, name }) => ({
            id: agentId,
            name,
          }))}
        />
        <ToggleActiveButton
          endpoint={`/api/schedules/${schedule.id}`}
          isActive={schedule.isActive}
        />
        <DeleteResourceButton
          endpoint={`/api/schedules/${schedule.id}`}
          resourceLabel="the schedule"
          redirectTo="/schedules"
          description="Its runs stay in Runs; the history of its occurrences is deleted."
        />
      </div>

      {!schedule.isActive && schedule.pausedReason && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Paused</AlertTitle>
          <AlertDescription>
            {schedule.pausedReason} Activate it to start counting again.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>
              <Link
                href={`/agents/${schedule.agentId}`}
                className="hover:underline"
              >
                {schedule.agentName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Next run</dt>
            <dd className="font-mono text-xs">
              {schedule.nextRunAt
                ? formatInZone(schedule.nextRunAt, schedule.timezone)
                : "—"}
            </dd>
            <dt className="text-muted-foreground">Message</dt>
            <dd>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-xs">
                {schedule.input}
              </pre>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <h2 className="text-sm font-medium">Occurrences</h2>
      {schedule.occurrences.length === 0 ? (
        <EmptyState
          title="It has not come due yet"
          description="Every time the schedule comes due it leaves a row here: whether it ran, was skipped or was blocked, and why."
        />
      ) : (
        <Table containerClassName={LIST_TABLE_CLASS}>
          <TableHeader>
            <TableRow>
              <TableHead>Due</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedule.occurrences.map((occurrence) => (
              <TableRow key={occurrence.id}>
                <TableCell className="font-mono text-xs">
                  {formatInZone(occurrence.nominalAt, schedule.timezone)}
                </TableCell>
                <TableCell>
                  <OccurrenceStatusBadge status={occurrence.status} />
                </TableCell>
                <TableCell className="max-w-md text-xs whitespace-normal text-muted-foreground">
                  {occurrence.reason ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  {occurrence.runId ? (
                    <Link
                      href={`/runs/${occurrence.runId}`}
                      className="text-sm hover:underline"
                    >
                      Open run
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
