import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentlathe/db", () => ({
  deleteExpiredAgentRuns: vi.fn(),
  deleteExpiredTranscripts: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));

import type { AppSettings } from "@agentlathe/db";
import {
  deleteExpiredAgentRuns,
  deleteExpiredTranscripts,
} from "@agentlathe/db";
import { after } from "next/server";
import { scheduleRetentionSweep } from "./retention";

const settings: AppSettings = {
  trackDashboardRuns: true,
  trackV1Runs: false,
  trackMcpRuns: false,
  agentRunTtlDays: 90,
  transcriptTtlDays: 14,
};

describe("scheduleRetentionSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules the sweep via after() instead of running inline", () => {
    scheduleRetentionSweep(settings);

    expect(after).toHaveBeenCalledTimes(2);
    expect(deleteExpiredAgentRuns).not.toHaveBeenCalled();
    expect(deleteExpiredTranscripts).not.toHaveBeenCalled();
  });

  it("invokes the expected deletes with the settings' TTLs", async () => {
    scheduleRetentionSweep(settings);

    const scheduled = vi
      .mocked(after)
      .mock.calls.map(([task]) => task as () => Promise<void>);
    await Promise.all(scheduled.map((callback) => callback()));

    expect(deleteExpiredAgentRuns).toHaveBeenCalledWith(90);
    expect(deleteExpiredTranscripts).toHaveBeenCalledWith(14);
  });

  it("swallows an error from a delete instead of letting it reject", async () => {
    vi.mocked(deleteExpiredAgentRuns).mockRejectedValueOnce(new Error("boom"));

    scheduleRetentionSweep(settings);

    const scheduled = vi
      .mocked(after)
      .mock.calls.map(([task]) => task as () => Promise<void>);
    await expect(
      Promise.all(scheduled.map((callback) => callback())),
    ).resolves.not.toThrow();
  });
});
