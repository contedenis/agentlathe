import { describe, expect, it } from "vitest";
import {
  describeTrigger,
  firstOccurrence,
  nextOccurrence,
  renderInput,
  type ScheduleTrigger,
  upcoming,
} from "./calendar";

const trigger = (overrides: Partial<ScheduleTrigger>): ScheduleTrigger => ({
  frequency: "daily",
  timeOfDay: "09:00",
  weekday: null,
  startDate: null,
  timezone: "UTC",
  ...overrides,
});

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());
const at = (value: string) => new Date(value);

describe("daily", () => {
  it("runs at the local time every day, later today when it has not passed yet", () => {
    const daily = trigger({
      timeOfDay: "09:00",
      timezone: "America/Argentina/Buenos_Aires",
    });
    expect(iso(upcoming(daily, at("2026-10-18T11:59:00Z"), 2))).toEqual([
      "2026-10-18T12:00:00.000Z",
      "2026-10-19T12:00:00.000Z",
    ]);
    expect(
      firstOccurrence(daily, at("2026-10-18T12:00:00Z")).toISOString(),
    ).toBe("2026-10-19T12:00:00.000Z");
  });

  it("a time that does not exist on the spring-forward day moves forward by the gap", () => {
    const daily = trigger({ timeOfDay: "02:30", timezone: "America/New_York" });
    expect(iso(upcoming(daily, at("2026-03-07T12:00:00Z"), 2))).toEqual([
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("a time that repeats on the fall-back day runs once, at the first of the two", () => {
    const daily = trigger({ timeOfDay: "01:30", timezone: "America/New_York" });
    expect(iso(upcoming(daily, at("2026-10-31T12:00:00Z"), 2))).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("does not skip the day when the clock jumps at midnight or by half an hour", () => {
    const santiago = trigger({
      timeOfDay: "00:30",
      timezone: "America/Santiago",
    });
    expect(
      firstOccurrence(santiago, at("2026-09-05T12:00:00Z")).toISOString(),
    ).toBe("2026-09-06T04:30:00.000Z");

    const lordHowe = trigger({
      timeOfDay: "02:15",
      timezone: "Australia/Lord_Howe",
    });
    expect(iso(upcoming(lordHowe, at("2026-10-02T12:00:00Z"), 3))).toEqual([
      "2026-10-02T15:45:00.000Z",
      "2026-10-03T15:45:00.000Z",
      "2026-10-04T15:15:00.000Z",
    ]);
  });

  it("keeps the local time in zones with a quarter-hour offset", () => {
    const kathmandu = trigger({ timezone: "Asia/Kathmandu" });
    const chatham = trigger({ timezone: "Pacific/Chatham" });
    expect(
      firstOccurrence(kathmandu, at("2026-10-18T00:00:00Z")).toISOString(),
    ).toBe("2026-10-18T03:15:00.000Z");
    expect(
      firstOccurrence(chatham, at("2026-09-26T00:00:00Z")).toISOString(),
    ).toBe("2026-09-26T19:15:00.000Z");
  });

  it("does not start before its start date", () => {
    const daily = trigger({ startDate: "2026-11-01" });
    expect(
      firstOccurrence(daily, at("2026-10-18T00:00:00Z")).toISOString(),
    ).toBe("2026-11-01T09:00:00.000Z");
  });
});

describe("hourly", () => {
  it("first runs at time_of_day, then every hour at that minute", () => {
    const hourly = trigger({ frequency: "hourly", timeOfDay: "14:20" });
    expect(iso(upcoming(hourly, at("2026-10-18T10:00:00Z"), 3))).toEqual([
      "2026-10-18T14:20:00.000Z",
      "2026-10-18T15:20:00.000Z",
      "2026-10-18T16:20:00.000Z",
    ]);
  });

  it("runs every real hour across a fall-back, including the repeated one", () => {
    const hourly = trigger({
      frequency: "hourly",
      timeOfDay: "00:15",
      timezone: "America/New_York",
    });
    const runs = [at("2026-11-01T05:15:00Z")];
    for (let i = 0; i < 2; i++) runs.push(nextOccurrence(hourly, runs[i]));
    expect(iso(runs)).toEqual([
      "2026-11-01T05:15:00.000Z",
      "2026-11-01T06:15:00.000Z",
      "2026-11-01T07:15:00.000Z",
    ]);
  });

  it("runs every real hour across a spring-forward", () => {
    const hourly = trigger({
      frequency: "hourly",
      timeOfDay: "00:15",
      timezone: "America/New_York",
    });
    expect(
      nextOccurrence(hourly, at("2026-03-08T06:15:00Z")).toISOString(),
    ).toBe("2026-03-08T07:15:00.000Z");
  });

  it("never runs less than an hour apart when the clock goes back half an hour", () => {
    const hourly = trigger({
      frequency: "hourly",
      timeOfDay: "00:45",
      timezone: "Australia/Lord_Howe",
    });
    const runs = [at("2026-04-04T13:45:00Z")];
    for (let i = 0; i < 3; i++) runs.push(nextOccurrence(hourly, runs[i]));
    for (let i = 1; i < runs.length; i++)
      expect(runs[i].getTime() - runs[i - 1].getTime()).toBeGreaterThanOrEqual(
        60 * 60 * 1000,
      );
    expect(iso(runs)).toEqual([
      "2026-04-04T13:45:00.000Z",
      "2026-04-04T14:45:00.000Z",
      "2026-04-04T16:15:00.000Z",
      "2026-04-04T17:15:00.000Z",
    ]);
  });
});

describe("weekdays and weekly", () => {
  it("weekdays skips from Friday to Monday", () => {
    const weekdays = trigger({
      frequency: "weekdays",
      timezone: "America/Argentina/Buenos_Aires",
    });
    expect(iso(upcoming(weekdays, at("2026-10-16T13:00:00Z"), 2))).toEqual([
      "2026-10-19T12:00:00.000Z",
      "2026-10-20T12:00:00.000Z",
    ]);
  });

  it("weekly runs on its weekday, with 0 as Sunday", () => {
    const sunday = trigger({ frequency: "weekly", weekday: 0 });
    const wednesday = trigger({ frequency: "weekly", weekday: 3 });
    expect(iso(upcoming(sunday, at("2026-10-18T10:00:00Z"), 2))).toEqual([
      "2026-10-25T09:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
    expect(
      firstOccurrence(wednesday, at("2026-10-18T10:00:00Z")).toISOString(),
    ).toBe("2026-10-21T09:00:00.000Z");
  });
});

describe("monthly", () => {
  it("runs on the start date's day, or on the last day of shorter months", () => {
    const monthly = trigger({
      frequency: "monthly",
      timeOfDay: "10:00",
      startDate: "2027-01-31",
      timezone: "America/Argentina/Buenos_Aires",
    });
    expect(iso(upcoming(monthly, at("2027-01-01T00:00:00Z"), 4))).toEqual([
      "2027-01-31T13:00:00.000Z",
      "2027-02-28T13:00:00.000Z",
      "2027-03-31T13:00:00.000Z",
      "2027-04-30T13:00:00.000Z",
    ]);
  });

  it("runs once a month on day 30, never twice", () => {
    const monthly = trigger({
      frequency: "monthly",
      startDate: "2027-01-30",
    });
    expect(iso(upcoming(monthly, at("2027-01-01T00:00:00Z"), 3))).toEqual([
      "2027-01-30T09:00:00.000Z",
      "2027-02-28T09:00:00.000Z",
      "2027-03-30T09:00:00.000Z",
    ]);
  });

  it("uses February 29 in a leap year", () => {
    const monthly = trigger({
      frequency: "monthly",
      timeOfDay: "10:00",
      startDate: "2028-01-29",
      timezone: "Europe/Madrid",
    });
    expect(iso(upcoming(monthly, at("2028-01-15T00:00:00Z"), 3))).toEqual([
      "2028-01-29T09:00:00.000Z",
      "2028-02-29T09:00:00.000Z",
      "2028-03-29T08:00:00.000Z",
    ]);
  });
});

describe("renderInput", () => {
  const context = {
    scheduleName: "Morning digest",
    timezone: "Europe/Madrid",
    nominalAt: at("2026-10-19T07:00:00Z"),
    lastSuccessAt: at("2026-10-18T07:00:12Z"),
  };

  it("fills the variables with the occurrence's time in the schedule's zone", () => {
    expect(
      renderInput(
        "{{schedule}} for {{date}} ({{datetime}}), due {{nominal_at}}, last ok {{ last_success_at }}",
        context,
      ),
    ).toBe(
      "Morning digest for 2026-10-19 (2026-10-19 09:00 Europe/Madrid), due 2026-10-19T07:00:00.000Z, last ok 2026-10-18T07:00:12.000Z",
    );
  });

  it("says never when there was no successful run, and leaves unknown names alone", () => {
    expect(
      renderInput("since {{last_success_at}} {{unknown}}", {
        ...context,
        lastSuccessAt: null,
      }),
    ).toBe("since never {{unknown}}");
  });
});

describe("describeTrigger", () => {
  const base = { timeOfDay: "09:30", weekday: null, startDate: null };
  it("says each preset the way the form offers it", () => {
    expect(describeTrigger({ ...base, frequency: "hourly" })).toBe(
      "Every hour at :30",
    );
    expect(describeTrigger({ ...base, frequency: "daily" })).toBe(
      "Daily at 09:30",
    );
    expect(describeTrigger({ ...base, frequency: "weekdays" })).toBe(
      "Weekdays at 09:30",
    );
    expect(describeTrigger({ ...base, frequency: "weekly", weekday: 0 })).toBe(
      "Every Sunday at 09:30",
    );
    expect(
      describeTrigger({
        ...base,
        frequency: "monthly",
        startDate: "2027-01-31",
      }),
    ).toBe("Monthly on day 31 at 09:30");
  });
});
