"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { useBreadcrumbTitle } from "@/components/breadcrumb-title";

const SECTION_LABELS: Record<string, string> = {
  agents: "Agents",
  tools: "Tools",
  skills: "Skills",
  "mcp-servers": "MCP Servers",
  metrics: "Metrics",
  runs: "Runs",
};

const LEAF_LABELS: Record<string, string> = {
  new: "New",
  edit: "Edit",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

type Crumb = { label: string; href?: string };

function buildCrumbs(pathname: string, entityName?: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Home" }];

  const [section, ...rest] = segments;
  const crumbs: Crumb[] = [
    { label: SECTION_LABELS[section] ?? section, href: `/${section}` },
  ];

  let acc = `/${section}`;
  for (const seg of rest) {
    acc += `/${seg}`;
    const label = UUID_RE.test(seg)
      ? (entityName ?? "Detail")
      : (LEAF_LABELS[seg] ?? seg);
    crumbs.push({ label, href: acc });
  }

  const last = crumbs[crumbs.length - 1];
  crumbs[crumbs.length - 1] = { label: last.label };
  return crumbs;
}

export function AppBreadcrumbs() {
  const pathname = usePathname();
  const entityName = useBreadcrumbTitle();
  const crumbs = buildCrumbs(pathname, entityName);

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1.5 text-sm"
    >
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.href ?? crumb.label}>
          {index > 0 && (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
          )}
          {crumb.href ? (
            <Link
              href={crumb.href}
              className="truncate text-muted-foreground transition-colors hover:text-foreground"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="truncate font-medium text-foreground">
              {crumb.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
