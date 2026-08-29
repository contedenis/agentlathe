import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./mutate";

function respondWith(body: string | null, init: ResponseInit) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("returns the parsed body on success and always sends JSON headers", async () => {
    const fetchMock = respondWith('{"id":"a1"}', { status: 200 });

    await expect(apiRequest("/api/thing")).resolves.toEqual({ id: "a1" });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("lets the caller override a header without losing the content type", async () => {
    const fetchMock = respondWith("{}", { status: 200 });

    await apiRequest("/api/thing", { headers: { "X-Trace": "1" } });

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Trace": "1",
    });
  });

  it("returns undefined for 204 instead of trying to parse an empty body", async () => {
    respondWith(null, { status: 204 });

    await expect(apiRequest("/api/thing")).resolves.toBeUndefined();
  });

  it("throws the error the API reported", async () => {
    respondWith('{"error":"Duplicate relation."}', { status: 400 });

    await expect(apiRequest("/api/thing")).rejects.toThrow(
      "Duplicate relation.",
    );
  });

  it("keeps the generic message when the failure body is not JSON", async () => {
    respondWith("<html>502</html>", { status: 502 });

    await expect(apiRequest("/api/thing")).rejects.toThrow(
      "Request failed (502)",
    );
  });

  it("keeps the generic message when the failure body has no error string", async () => {
    respondWith('{"detail":"nope"}', { status: 500 });

    await expect(apiRequest("/api/thing")).rejects.toThrow(
      "Request failed (500)",
    );
  });
});
