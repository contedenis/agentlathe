"use client";

import {
  Bot,
  ChartNoAxesColumn,
  Home,
  MessagesSquare,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/mcp-servers", label: "MCP Servers", icon: Plug },
  { href: "/runs", label: "Runs", icon: MessagesSquare },
  { href: "/metrics", label: "Metrics", icon: ChartNoAxesColumn },
] as const;

export function NavMain() {
  const pathname = usePathname();

  return (
    <>
      <div className="px-2 py-1.5 font-mono text-[10px] font-medium tracking-[0.16em] text-faint uppercase">
        Workshop
      </div>
      <SidebarMenu>
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                render={<Link href={item.href} />}
                isActive={isActive}
                className={cn(
                  "relative",
                  isActive &&
                    "text-primary data-active:bg-primary/10! [&>svg]:text-primary",
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
                )}
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </>
  );
}
