import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { useMcpToolDiscovery } from "./use-mcp-tool-discovery";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMcpToolDiscovery", () => {
  it("posts a serverUrl body when overriding the server's saved URL", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ tools: [] });
    const { result } = renderHook(() => useMcpToolDiscovery());

    await act(async () => {
      await result.current.discover({
        serverId: "srv-1",
        serverUrl: "https://override.test/mcp",
      });
    });

    expect(apiRequest).toHaveBeenCalledWith("/api/mcp-servers/srv-1/tools", {
      method: "POST",
      body: JSON.stringify({ serverUrl: "https://override.test/mcp" }),
    });
  });

  it("posts an undefined body when using the server's saved URL", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ tools: [] });
    const { result } = renderHook(() => useMcpToolDiscovery());

    await act(async () => {
      await result.current.discover({ serverId: "srv-1" });
    });

    expect(apiRequest).toHaveBeenCalledWith("/api/mcp-servers/srv-1/tools", {
      method: "POST",
      body: undefined,
    });
  });

  it("transitions from loading to ready with the discovered tools", async () => {
    let resolveRequest: (value: { tools: { name: string }[] }) => void =
      () => {};
    vi.mocked(apiRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { result } = renderHook(() => useMcpToolDiscovery());

    let discoverPromise!: Promise<void>;
    act(() => {
      discoverPromise = result.current.discover({ serverId: "srv-1" });
    });

    expect(result.current.state).toEqual({ status: "loading" });

    await act(async () => {
      resolveRequest({ tools: [{ name: "search" }] });
      await discoverPromise;
    });

    expect(result.current.state).toEqual({
      status: "ready",
      tools: [{ name: "search" }],
    });
  });

  it("transitions to an error state when the request rejects", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("connection refused"));
    const { result } = renderHook(() => useMcpToolDiscovery());

    await act(async () => {
      await result.current.discover({ serverId: "srv-1" });
    });

    expect(result.current.state).toEqual({
      status: "error",
      message: "connection refused",
    });
  });
});
