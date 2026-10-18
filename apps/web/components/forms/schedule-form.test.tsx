import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { ScheduleForm, type ScheduleFormValues } from "./schedule-form";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const agents = [
  { id: "agent-1", name: "Digest bot" },
  { id: "agent-2", name: "Billing bot" },
];

const saved = (overrides: Partial<ScheduleFormValues>): ScheduleFormValues => ({
  id: "schedule-1",
  agentId: "agent-1",
  name: "Morning digest",
  frequency: "daily",
  timeOfDay: "09:00",
  weekday: null,
  startDate: null,
  timezone: "UTC",
  input: "Summarize {{date}}.",
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const nextRuns = () =>
  within(screen.getByRole("list", { name: "Next runs" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("ScheduleForm", () => {
  it("creates a daily schedule in the browser's time zone, sending only the fields its preset uses", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    render(
      <ScheduleForm agents={agents} onSuccess={onSuccess} onCancel={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("Name"), "Morning digest");
    await user.type(screen.getByLabelText("Message"), "Summarize the news.");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        agentId: "agent-1",
        name: "Morning digest",
        frequency: "daily",
        timeOfDay: "09:00",
        weekday: null,
        startDate: null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        input: "Summarize the news.",
      }),
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("previews the next five runs in the schedule's time zone", () => {
    render(
      <ScheduleForm
        initial={saved({})}
        agents={agents}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(nextRuns()).toEqual([
      "Mon, Oct 19, 09:00",
      "Tue, Oct 20, 09:00",
      "Wed, Oct 21, 09:00",
      "Thu, Oct 22, 09:00",
      "Fri, Oct 23, 09:00",
    ]);
  });

  it("warns that a monthly day past 28 runs on the last day of shorter months", () => {
    render(
      <ScheduleForm
        initial={saved({ frequency: "monthly", startDate: "2026-10-31" })}
        agents={agents}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "In months without day 31, it runs on the last day of the month.",
      ),
    ).toBeInTheDocument();
    expect(nextRuns()).toEqual([
      "Sat, Oct 31, 09:00",
      "Mon, Nov 30, 09:00",
      "Thu, Dec 31, 09:00",
      "Sun, Jan 31, 09:00",
      "Sun, Feb 28, 09:00",
    ]);
  });

  it("updates a weekly schedule with its weekday and no start date", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    render(
      <ScheduleForm
        initial={saved({ frequency: "weekly", weekday: 3 })}
        agents={agents}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("On")).toHaveTextContent("Wednesday");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const [url, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(url).toBe("/api/schedules/schedule-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      frequency: "weekly",
      weekday: 3,
      startDate: null,
      timezone: "UTC",
    });
  });

  it("explains how an hourly schedule repeats after its first run", () => {
    render(
      <ScheduleForm
        initial={saved({ frequency: "hourly", timeOfDay: "14:20" })}
        agents={agents}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("First run at")).toHaveValue("14:20");
    expect(screen.getByText(/Then every hour at :20\./)).toBeInTheDocument();
    expect(nextRuns().slice(0, 2)).toEqual([
      "Sun, Oct 18, 14:20",
      "Sun, Oct 18, 15:20",
    ]);
  });

  it("rejects a time that is not HH:MM on a 24-hour clock without sending", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleForm
        initial={saved({})}
        agents={agents}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const time = screen.getByLabelText("At");
    await user.clear(time);
    await user.type(time, "9am");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("The time must be HH:MM, 24-hour."),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
