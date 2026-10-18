import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleListRow } from "@/lib/queries-schedules";
import { SchedulesList } from "./schedules-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

const agents = [{ id: "agent-1", name: "Digest bot" }];

const row = (overrides: Partial<ScheduleListRow>): ScheduleListRow => ({
  id: "schedule-1",
  agentId: "agent-1",
  agentName: "Digest bot",
  name: "Morning digest",
  frequency: "daily",
  timeOfDay: "09:00",
  weekday: null,
  startDate: null,
  timezone: "UTC",
  input: "Summarize.",
  isActive: true,
  nextRunAt: new Date("2026-10-19T09:00:00Z"),
  consecutiveFailures: 0,
  pausedReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  lastOccurrence: null,
  ...overrides,
});

describe("SchedulesList", () => {
  it("lists each schedule with its trigger, next run and last result", () => {
    render(
      <SchedulesList
        schedules={[
          row({
            lastOccurrence: {
              id: "occurrence-1",
              scheduleId: "schedule-1",
              nominalAt: new Date("2026-10-18T09:00:00Z"),
              status: "skipped_missed",
              reason: "Due at …",
              runId: null,
              startedAt: new Date("2026-10-18T09:05:00Z"),
              finishedAt: new Date("2026-10-18T09:05:00Z"),
            },
          }),
        ]}
        agents={agents}
        schedulerSecondsAgo={12}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Morning digest" }),
    ).toHaveAttribute("href", "/schedules/schedule-1");
    expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
    expect(screen.getByText("Mon, Oct 19, 09:00")).toBeInTheDocument();
    expect(screen.getByText("skipped · missed")).toBeInTheDocument();
    expect(
      screen.getByText("Scheduler running · last tick 12 s ago"),
    ).toBeInTheDocument();
  });

  it("shows a paused schedule with its reason and no next run", () => {
    render(
      <SchedulesList
        schedules={[
          row({
            isActive: false,
            nextRunAt: null,
            pausedReason: "Paused after 5 consecutive failures.",
          }),
        ]}
        agents={agents}
        schedulerSecondsAgo={5}
      />,
    );

    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(
      screen.getByText("Paused after 5 consecutive failures."),
    ).toBeInTheDocument();
    expect(screen.getByText("never ran")).toBeInTheDocument();
  });

  it("warns when no scheduler has ticked recently, because nothing will fire", () => {
    render(
      <SchedulesList
        schedules={[]}
        agents={agents}
        schedulerSecondsAgo={null}
      />,
    );

    expect(screen.getByText("No scheduler is running")).toBeInTheDocument();
    expect(
      screen.getByText(/No scheduler has ticked yet\./),
    ).toBeInTheDocument();
  });
});
