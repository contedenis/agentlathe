import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { NavMain } from "./nav-main";

const renderNav = () =>
  render(
    <SidebarProvider>
      <NavMain />
    </SidebarProvider>,
  );

const linkNames = () =>
  within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map((link) => link.textContent);

beforeEach(() => {
  pathname.current = "/";
  window.localStorage.clear();
});

describe("NavMain", () => {
  it("lists every section, grouped by task", () => {
    renderNav();

    expect(linkNames()).toEqual([
      "Home",
      "Agents",
      "Schedules",
      "Memory",
      "HTTP Tools",
      "Skills",
      "MCP Servers",
      "Knowledge",
      "Runs",
      "Metrics",
      "Settings",
    ]);
    for (const label of ["Build", "Library", "Review"])
      expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("marks the section of a nested page as the current one", () => {
    pathname.current = "/runs/123";
    renderNav();

    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("collapses the library, and leaves the other groups in place", async () => {
    renderNav();

    await userEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(screen.queryByRole("link", { name: "Skills" })).toBeNull();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runs" })).toBeInTheDocument();
  });

  it("keeps the library open while one of its pages is the current one, and does not collapse it on leaving", async () => {
    pathname.current = "/skills";
    const { rerender } = renderNav();

    await userEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    pathname.current = "/runs";
    rerender(
      <SidebarProvider>
        <NavMain />
      </SidebarProvider>,
    );

    expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
  });

  it("remembers a collapsed library across reloads, and still opens it on one of its pages", async () => {
    const first = renderNav();
    await userEvent.click(screen.getByRole("button", { name: "Library" }));
    first.unmount();

    renderNav();
    expect(screen.queryByRole("link", { name: "Skills" })).toBeNull();

    pathname.current = "/skills";
    renderNav();
    expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
  });
});
