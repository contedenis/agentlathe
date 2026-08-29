import { describe, expect, it, vi } from "vitest";
import { isTrustedRequest, type RequestOrigin } from "./csrf";

function post(overrides: Partial<RequestOrigin> = {}): RequestOrigin {
  return {
    method: "POST",
    host: "localhost:3000",
    origin: null,
    secFetchSite: null,
    ...overrides,
  };
}

describe("isTrustedRequest — safe methods", () => {
  it("never blocks a GET, whatever the headers say", () => {
    expect(
      isTrustedRequest({
        method: "GET",
        host: "evil.example",
        origin: "http://evil.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
  });

  it("lets HEAD and OPTIONS through as well", () => {
    expect(isTrustedRequest(post({ method: "HEAD" }))).toBe(true);
    expect(isTrustedRequest(post({ method: "OPTIONS" }))).toBe(true);
  });

  it("matches the method case-insensitively", () => {
    expect(isTrustedRequest(post({ method: "get" }))).toBe(true);
  });
});

describe("isTrustedRequest — Sec-Fetch-Site", () => {
  it("accepts a same-origin request", () => {
    expect(isTrustedRequest(post({ secFetchSite: "same-origin" }))).toBe(true);
  });

  it("accepts a request typed in the address bar", () => {
    expect(isTrustedRequest(post({ secFetchSite: "none" }))).toBe(true);
  });

  it("rejects a cross-site request", () => {
    expect(isTrustedRequest(post({ secFetchSite: "cross-site" }))).toBe(false);
  });

  it("rejects a same-site request from another subdomain", () => {
    expect(isTrustedRequest(post({ secFetchSite: "same-site" }))).toBe(false);
  });

  it("wins over a matching Origin", () => {
    expect(
      isTrustedRequest(
        post({
          secFetchSite: "cross-site",
          origin: "http://localhost:3000",
        }),
      ),
    ).toBe(false);
  });
});

describe("isTrustedRequest — Origin against Host", () => {
  it("accepts an Origin whose host matches", () => {
    expect(isTrustedRequest(post({ origin: "http://localhost:3000" }))).toBe(
      true,
    );
  });

  it("rejects an Origin from another site", () => {
    expect(isTrustedRequest(post({ origin: "http://evil.example" }))).toBe(
      false,
    );
  });

  it("rejects an Origin on the same host but another port", () => {
    expect(isTrustedRequest(post({ origin: "http://localhost:4000" }))).toBe(
      false,
    );
  });

  it("rejects the opaque 'null' Origin of a sandboxed frame", () => {
    expect(isTrustedRequest(post({ origin: "null" }))).toBe(false);
  });
});

describe("isTrustedRequest — programmatic clients", () => {
  it("accepts a POST with neither Origin nor Sec-Fetch-Site", () => {
    expect(isTrustedRequest(post())).toBe(true);
  });

  it("keeps accepting the other unsafe methods without those headers", () => {
    for (const method of ["PATCH", "PUT", "DELETE"])
      expect(isTrustedRequest(post({ method }))).toBe(true);
  });
});

describe("isTrustedRequest — Host allowlist", () => {
  it("accepts the loopback IP", () => {
    expect(isTrustedRequest(post({ host: "127.0.0.1:3000" }))).toBe(true);
  });

  it("rejects a rebound host even when the request looks same-origin", () => {
    expect(
      isTrustedRequest(
        post({
          host: "rebind.example",
          origin: "http://rebind.example",
          secFetchSite: "same-origin",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a missing Host", () => {
    expect(isTrustedRequest(post({ host: null }))).toBe(false);
  });

  it("accepts the host of APP_URL when it is configured", () => {
    expect(
      isTrustedRequest(
        post({
          host: "lathe.example.com",
          appUrl: "https://lathe.example.com",
        }),
      ),
    ).toBe(true);
  });

  it("still accepts localhost once APP_URL is configured", () => {
    expect(
      isTrustedRequest(post({ appUrl: "https://lathe.example.com" })),
    ).toBe(true);
  });

  it("keeps the port of APP_URL as part of the allowed host", () => {
    expect(
      isTrustedRequest(
        post({
          host: "lathe.example.com",
          appUrl: "https://lathe.example.com:8443",
        }),
      ),
    ).toBe(false);
  });

  it("falls back to the defaults when APP_URL is not a URL", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(isTrustedRequest(post({ appUrl: "not a valid url" }))).toBe(true);
    expect(
      isTrustedRequest(
        post({ host: "lathe.example.com", appUrl: "not a valid url" }),
      ),
    ).toBe(false);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("APP_URL"));

    warned.mockRestore();
  });

  it("compares the Host case-insensitively", () => {
    expect(isTrustedRequest(post({ host: "LOCALHOST:3000" }))).toBe(true);
  });
});
