import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { ApiEndpoint } from "@/components/api-endpoint";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { BreadcrumbTitleProvider } from "@/components/breadcrumb-title";
import { McpEndpoint } from "@/components/mcp-endpoint";
import { NavMain } from "@/components/nav-main";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { listActiveAgentOptions } from "@/lib/queries";

export const metadata: Metadata = {
  title: "agentlathe",
  description: "Self-hosted admin panel for AI agents.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Postgres may not be reachable yet (first run before Docker is up). An empty agent list
  // keeps the shell and each page's error.tsx usable instead of falling to global-error.tsx.
  let mcpAgents: Awaited<ReturnType<typeof listActiveAgentOptions>> = [];
  try {
    mcpAgents = await listActiveAgentOptions();
  } catch (err) {
    console.error(err);
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <BreadcrumbTitleProvider>
            <SidebarProvider
              style={{ "--sidebar-width": "232px" } as React.CSSProperties}
            >
              <Sidebar>
                <SidebarHeader>
                  <Link
                    href="/"
                    className="flex items-center gap-2 px-2 py-1 text-lg font-semibold tracking-tight"
                  >
                    <svg
                      className="size-6 shrink-0 text-primary"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.6}
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="12" r="7" />
                      <circle
                        cx="11"
                        cy="12"
                        r="2.4"
                        fill="currentColor"
                        stroke="none"
                      />
                      <path
                        d="M18.5 12H23M20 9.5 23 8M20 14.5 23 16"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span>
                      agent<span className="text-primary">lathe</span>
                    </span>
                  </Link>
                </SidebarHeader>
                <SidebarContent>
                  <NavMain />
                </SidebarContent>
                <SidebarFooter>
                  <McpEndpoint agents={mcpAgents} />
                  <ApiEndpoint />
                </SidebarFooter>
              </Sidebar>
              <SidebarInset className="min-w-0">
                <header className="sticky top-0 z-20 flex h-[58px] items-center gap-4 border-b bg-background/80 px-[22px] backdrop-blur-md">
                  <SidebarTrigger />
                  <AppBreadcrumbs />
                  <div className="flex-1" />
                  <ThemeToggle />
                </header>
                <main className="flex-1 px-[30px] pt-[26px] pb-[60px]">
                  {children}
                </main>
              </SidebarInset>
            </SidebarProvider>
          </BreadcrumbTitleProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
