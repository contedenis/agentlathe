import { type NextRequest, NextResponse } from "next/server";
import { isTrustedRequest } from "@/lib/csrf";

export function proxy(req: NextRequest) {
  const trusted = isTrustedRequest({
    method: req.method,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    appUrl: process.env.APP_URL,
  });

  if (!trusted)
    return NextResponse.json(
      { error: "cross-site request rejected" },
      { status: 403 },
    );

  return NextResponse.next();
}
