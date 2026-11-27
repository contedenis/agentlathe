"use client";

import {
  RUN_LABEL_MAX_LENGTH,
  type ScheduleFrequency,
} from "@agentlathe/db/constants";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetFooter } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatInZone } from "@/lib/format";
import { apiRequest } from "@/lib/mutate";
import {
  INPUT_VARIABLES,
  upcoming,
  WEEKDAY_NAMES,
} from "@/lib/scheduler/calendar";

export type ScheduleAgentOption = { id: string; name: string };

export type ScheduleFormValues = {
  id: string;
  agentId: string;
  name: string;
  frequency: string;
  timeOfDay: string;
  weekday: number | null;
  startDate: string | null;
  timezone: string;
  input: string;
  subjectId: string | null;
  memoryKey: string | null;
};

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function today(timeZone: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());
}

export type ScheduleDraft = Partial<Omit<ScheduleFormValues, "id">>;

export function ScheduleForm({
  initial,
  draft,
  agents,
  onSuccess,
  onCancel,
}: {
  initial?: ScheduleFormValues;
  draft?: ScheduleDraft;
  agents: ScheduleAgentOption[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const mode = initial ? "edit" : "create";
  const start = { ...initial, ...draft };
  const [timezone] = useState(
    () => start.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [agentId, setAgentId] = useState(start.agentId ?? agents[0]?.id ?? "");
  const [name, setName] = useState(start.name ?? "");
  const [frequency, setFrequency] = useState(
    (start.frequency as ScheduleFrequency | undefined) ?? "daily",
  );
  const [timeOfDay, setTimeOfDay] = useState(start.timeOfDay ?? "09:00");
  const [weekday, setWeekday] = useState(start.weekday ?? 1);
  const [startDate, setStartDate] = useState(
    () => start.startDate ?? today(timezone),
  );
  const [input, setInput] = useState(start.input ?? "");
  const [subjectId, setSubjectId] = useState(start.subjectId ?? "");
  const [memoryKey, setMemoryKey] = useState(start.memoryKey ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validTime = TIME_OF_DAY.test(timeOfDay);
  const dayOfMonth = Number(startDate.slice(8, 10));
  const preview = useMemo(() => {
    if (!validTime || (frequency === "monthly" && !startDate)) return [];
    try {
      return upcoming(
        { frequency, timeOfDay, weekday, startDate, timezone },
        new Date(),
        5,
      );
    } catch {
      return [];
    }
  }, [frequency, timeOfDay, weekday, startDate, timezone, validTime]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!validTime) {
      setError("The time must be HH:MM, 24-hour.");
      return;
    }

    setPending(true);
    const body = {
      agentId,
      name,
      frequency,
      timeOfDay,
      weekday: frequency === "weekly" ? weekday : null,
      startDate: frequency === "monthly" ? startDate : null,
      timezone,
      input,
      subjectId: subjectId.trim() || null,
      memoryKey: memoryKey.trim() || null,
    };
    try {
      if (mode === "create") {
        await apiRequest("/api/schedules", {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast.success("Schedule created.");
      } else {
        await apiRequest(`/api/schedules/${initial?.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Schedule updated.");
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
          <Label htmlFor="schedule-agent">Agent</Label>
          <Select
            value={agentId}
            items={agents.map((agent) => ({
              value: agent.id,
              label: agent.name,
            }))}
            onValueChange={(value) => setAgentId(value as string)}
          >
            <SelectTrigger id="schedule-agent" className="w-full">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-name">Name</Label>
          <Input
            id="schedule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-frequency">Repeats</Label>
            <Select
              value={frequency}
              items={FREQUENCIES}
              onValueChange={(value) =>
                setFrequency(value as ScheduleFrequency)
              }
            >
              <SelectTrigger id="schedule-frequency" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-time">
              {frequency === "hourly" ? "First run at" : "At"}
            </Label>
            <Input
              id="schedule-time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value.trim())}
              placeholder="09:00"
              aria-invalid={!validTime}
              className="font-mono"
              required
            />
          </div>
        </div>
        {frequency === "weekly" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-weekday">On</Label>
            <Select
              value={String(weekday)}
              items={WEEKDAY_ORDER.map((day) => ({
                value: String(day),
                label: WEEKDAY_NAMES[day],
              }))}
              onValueChange={(value) => setWeekday(Number(value))}
            >
              <SelectTrigger id="schedule-weekday" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAY_ORDER.map((day) => (
                  <SelectItem key={day} value={String(day)}>
                    {WEEKDAY_NAMES[day]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {frequency === "monthly" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-start">Starting on</Label>
            <Input
              id="schedule-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
            {dayOfMonth > 28 && (
              <span className="text-xs text-warning">
                In months without day {dayOfMonth}, it runs on the last day of
                the month.
              </span>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {frequency === "hourly" && validTime
            ? `Then every hour at :${timeOfDay.slice(3)}. `
            : ""}
          Time zone: <span className="font-mono">{timezone}</span>
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-input">Message</Label>
          <Textarea
            id="schedule-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            required
          />
          <span className="text-xs text-muted-foreground">
            What the agent receives each time. Variables:{" "}
            {INPUT_VARIABLES.map((variable) => `{{${variable}}}`).join(", ")}.
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-subject">Subject</Label>
            <Input
              id="schedule-subject"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              maxLength={RUN_LABEL_MAX_LENGTH}
              placeholder="none"
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-memory-key">Memory key</Label>
            <Input
              id="schedule-memory-key"
              value={memoryKey}
              onChange={(e) => setMemoryKey(e.target.value)}
              maxLength={RUN_LABEL_MAX_LENGTH}
              placeholder="none"
              className="font-mono"
            />
          </div>
          <span className="col-span-2 text-xs text-muted-foreground">
            Optional. The same as the <code>x-subject-id</code> and{" "}
            <code>x-memory-key</code> headers on <code>/v1</code>.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Next runs</p>
          {preview.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Fill in the trigger to see when it runs.
            </p>
          ) : (
            <ul
              aria-label="Next runs"
              className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground"
            >
              {preview.map((date) => (
                <li key={date.toISOString()}>{formatInZone(date, timezone)}</li>
              ))}
            </ul>
          )}
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
        <Button type="submit" disabled={pending || !agentId}>
          {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}
