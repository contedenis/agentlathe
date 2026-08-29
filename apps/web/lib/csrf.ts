const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
const DEFAULT_HOSTS = ["localhost:3000", "127.0.0.1:3000"];

export type RequestOrigin = {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  appUrl?: string;
};

// Memoized on the last-seen appUrl so a bad APP_URL warns once, not per request.
let cachedAppUrl: string | undefined;
let cachedHosts: string[] = DEFAULT_HOSTS;

function allowedHosts(appUrl?: string): string[] {
  if (appUrl === cachedAppUrl) return cachedHosts;
  cachedAppUrl = appUrl;
  if (!appUrl) {
    cachedHosts = DEFAULT_HOSTS;
    return cachedHosts;
  }
  try {
    cachedHosts = [...DEFAULT_HOSTS, new URL(appUrl).host.toLowerCase()];
  } catch {
    console.warn(
      `APP_URL is set to "${appUrl}" but is not a valid URL; falling back to the default allowed hosts.`,
    );
    cachedHosts = DEFAULT_HOSTS;
  }
  return cachedHosts;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isTrustedRequest({
  method,
  host,
  origin,
  secFetchSite,
  appUrl,
}: RequestOrigin): boolean {
  if (SAFE_METHODS.includes(method.toUpperCase())) return true;

  const requestHost = host?.toLowerCase() ?? null;
  if (!requestHost || !allowedHosts(appUrl).includes(requestHost)) return false;

  if (secFetchSite)
    return secFetchSite === "same-origin" || secFetchSite === "none";

  // No browser header at all: curl, OpenAI SDKs and MCP clients; a forgery cannot omit both.
  if (!origin) return true;

  return hostOf(origin) === requestHost;
}
