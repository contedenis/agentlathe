"use client";

import {
  Bot,
  Brain,
  CalendarClock,
  ChartNoAxesColumn,
  ChevronRight,
  Home,
  Library,
  type LucideIcon,
  MessagesSquare,
  Plug,
  Settings,
  Sparkles,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };

const HOME: NavItem = { href: "/", label: "Home", icon: Home };

const BUILD: NavItem[] = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/memory", label: "Memory", icon: Brain },
];

const LIBRARY: NavItem[] = [
  { href: "/tools", label: "HTTP Tools", icon: Wrench },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/mcp-servers", label: "MCP Servers", icon: Plug },
  { href: "/knowledge", label: "Knowledge", icon: Library },
];

const REVIEW: NavItem[] = [
  { href: "/runs", label: "Runs", icon: MessagesSquare },
  { href: "/metrics", label: "Metrics", icon: ChartNoAxesColumn },
];

const SETTINGS: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};

const LIBRARY_OPEN_KEY = "sidebar-library-open";

const LABEL_CLASS =
  "h-auto px-2 py-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-faint uppercase";

function isActive(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

function NavItems({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <SidebarMenu>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              render={
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                />
              }
              isActive={active}
              className={cn(
                "relative",
                active &&
                  "text-primary data-active:bg-primary/10! [&>svg]:text-primary",
              )}
            >
              {active && (
                <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
              )}
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function NavMain() {
  const pathname = usePathname();
  const [libraryOpen, setLibraryOpen] = useState(true);
  const inLibrary = LIBRARY.some((item) => isActive(pathname, item.href));

  useEffect(() => {
    setLibraryOpen(window.localStorage.getItem(LIBRARY_OPEN_KEY) !== "false");
  }, []);

  function toggleLibrary(open: boolean) {
    setLibraryOpen(open);
    window.localStorage.setItem(LIBRARY_OPEN_KEY, String(open));
  }

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col">
      <SidebarGroup className="pb-0">
        <NavItems items={[HOME]} pathname={pathname} />
      </SidebarGroup>
      <SidebarGroup className="pb-0">
        <SidebarGroupLabel className={LABEL_CLASS}>Build</SidebarGroupLabel>
        <NavItems items={BUILD} pathname={pathname} />
      </SidebarGroup>
      <Collapsible
        open={libraryOpen || inLibrary}
        onOpenChange={toggleLibrary}
        disabled={inLibrary}
        render={<SidebarGroup className="pb-0" />}
      >
        <SidebarGroupLabel
          className={cn(
            LABEL_CLASS,
            "w-full justify-between hover:text-foreground",
          )}
          render={<CollapsibleTrigger />}
        >
          Library
          {!inLibrary && (
            <ChevronRight className="size-3! transition-transform group-data-[panel-open]:rotate-90" />
          )}
        </SidebarGroupLabel>
        <CollapsibleContent>
          <NavItems items={LIBRARY} pathname={pathname} />
        </CollapsibleContent>
      </Collapsible>
      <SidebarGroup>
        <SidebarGroupLabel className={LABEL_CLASS}>Review</SidebarGroupLabel>
        <NavItems items={REVIEW} pathname={pathname} />
      </SidebarGroup>
      <SidebarGroup className="mt-auto">
        <NavItems items={[SETTINGS]} pathname={pathname} />
      </SidebarGroup>
    </nav>
  );
}
