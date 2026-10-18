import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { type AppSettings, TrackingToggles } from "./tracking-toggles";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

const settings: AppSettings = {
  trackDashboardRuns: true,
  trackV1Runs: true,
  trackMcpRuns: true,
  trackScheduleRuns: true,
  agentRunTtlDays: 30,
  transcriptTtlDays: 7,
  judgeModel: "typesafe/jev-1.13",
};

describe("TrackingToggles judge model", () => {
  it("shows the current judge model and the host that serves it", () => {
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    expect(screen.getByLabelText("Judge model")).toHaveValue(
      "typesafe/jev-1.13",
    );
    expect(
      screen.getByText(/Jev model used to judge runs against criteria/),
    ).toHaveTextContent("served by openrouter.ai.");
  });

  it("patches only the trimmed judge model on blur", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    const input = screen.getByLabelText("Judge model");
    await user.clear(input);
    await user.type(input, " vendor/other-judge ");
    await user.tab();

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ judgeModel: "vendor/other-judge" }),
    });
  });

  it("sends nothing when the value did not change", async () => {
    const user = userEvent.setup();
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    await user.click(screen.getByLabelText("Judge model"));
    await user.tab();

    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("rejects an empty value and restores the previous one", async () => {
    const user = userEvent.setup();
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    const input = screen.getByLabelText("Judge model");
    await user.clear(input);
    await user.tab();

    expect(apiRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The judge model cannot be empty.",
    );
    expect(input).toHaveValue("typesafe/jev-1.13");
  });

  it("restores the previous value when the save fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValue(new Error("bad model"));
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    const input = screen.getByLabelText("Judge model");
    await user.clear(input);
    await user.type(input, "nope");
    await user.tab();

    expect(toast.error).toHaveBeenCalledWith("bad model");
    expect(input).toHaveValue("typesafe/jev-1.13");
  });
});

describe("TrackingToggles sources", () => {
  it("turns off recording of scheduled runs with its own flag", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    render(<TrackingToggles initial={settings} judgeHost="openrouter.ai" />);

    await user.click(screen.getByRole("switch", { name: "Schedules" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ trackScheduleRuns: false }),
    });
  });
});
