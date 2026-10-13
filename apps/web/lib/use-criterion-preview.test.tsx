import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import {
  PREVIEW_DEBOUNCE_MS,
  type PreviewDraft,
  useCriterionPreview,
} from "./use-criterion-preview";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));

const draft: PreviewDraft = {
  question: "Q?",
  passDescription: null,
  failDescription: "Bad.",
  appliesWhen: null,
  failBelow: 0.2,
  passAbove: 0.8,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useCriterionPreview", () => {
  it("sends no request when it unmounts during the debounce", async () => {
    const { result, unmount } = renderHook(() => useCriterionPreview("r1"));

    act(() => result.current.schedule(draft));
    unmount();
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 2);

    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("aborts the request in flight when it unmounts", async () => {
    vi.mocked(apiRequest).mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useCriterionPreview("r1"));

    act(() => result.current.schedule(draft));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    });
    const init = vi.mocked(apiRequest).mock.calls[0][1];
    expect(init?.signal?.aborted).toBe(false);

    unmount();

    expect(init?.signal?.aborted).toBe(true);
  });

  it("aborts the previous request when a newer draft is scheduled", async () => {
    vi.mocked(apiRequest).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useCriterionPreview("r1"));

    act(() => result.current.schedule(draft));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    });
    const first = vi.mocked(apiRequest).mock.calls[0][1];

    act(() => result.current.schedule({ ...draft, question: "Q2?" }));

    expect(first?.signal?.aborted).toBe(true);
  });

  it("stays idle without a run to check against", async () => {
    const { result } = renderHook(() => useCriterionPreview(null));

    act(() => result.current.schedule(draft));
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 2);

    expect(apiRequest).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "idle" });
  });
});
