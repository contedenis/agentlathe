"use client";

import { useRouter } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { ActiveBadge } from "@/components/active-badge";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import {
  LIST_SHELL_CLASS,
  LIST_TABLE_CLASS,
  ListSearch,
} from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useListFilter } from "@/lib/use-list-filter";

export type ResourceColumn<T> = {
  header: string;
  cell: (item: T) => ReactNode;
  className?: string;
};

type ResourceRow = { id: string; name: string; isActive: boolean | null };

type SheetState<T> =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; item: T };

export function ResourceList<T extends ResourceRow>({
  eyebrow,
  title,
  description,
  items,
  columns,
  searchPlaceholder,
  emptyTitle,
  emptyDescription,
  createLabel,
  emptyActionLabel,
  sheetTitleCreate,
  sheetTitleEdit,
  endpointBase,
  resourceLabel,
  redirectTo,
  FormComponent,
}: {
  eyebrow: string;
  title: string;
  description: string;
  items: T[];
  columns: ResourceColumn<T>[];
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  createLabel: string;
  emptyActionLabel: string;
  sheetTitleCreate: string;
  sheetTitleEdit: string;
  endpointBase: (id: string) => string;
  resourceLabel: string;
  redirectTo: string;
  FormComponent: ComponentType<{
    initial?: T;
    onSuccess: () => void;
    onCancel: () => void;
  }>;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState<SheetState<T>>({ mode: "closed" });
  const { query, setQuery, filtered } = useListFilter(
    items,
    (item) => item.name,
  );

  function handleSuccess() {
    setSheet({ mode: "closed" });
    router.refresh();
  }

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        action={
          <Button onClick={() => setSheet({ mode: "create" })}>
            {createLabel}
          </Button>
        }
      />
      {items.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={
            <Button onClick={() => setSheet({ mode: "create" })}>
              {emptyActionLabel}
            </Button>
          }
        />
      ) : (
        <>
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder}
            filtered={filtered.length}
            total={items.length}
          />
          <Table containerClassName={LIST_TABLE_CLASS}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {columns.map((column) => (
                  <TableHead key={column.header}>{column.header}</TableHead>
                ))}
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setSheet({ mode: "edit", item })}
                    >
                      {item.name}
                    </button>
                  </TableCell>
                  {columns.map((column) => (
                    <TableCell key={column.header} className={column.className}>
                      {column.cell(item)}
                    </TableCell>
                  ))}
                  <TableCell>
                    <ActiveBadge isActive={item.isActive} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <ToggleActiveButton
                        endpoint={endpointBase(item.id)}
                        isActive={Boolean(item.isActive)}
                        size="sm"
                      />
                      <DeleteResourceButton
                        endpoint={endpointBase(item.id)}
                        resourceLabel={resourceLabel}
                        redirectTo={redirectTo}
                        size="sm"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      <Sheet
        open={sheet.mode !== "closed"}
        onOpenChange={(open) => !open && setSheet({ mode: "closed" })}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {sheet.mode === "edit" ? sheetTitleEdit : sheetTitleCreate}
            </SheetTitle>
          </SheetHeader>
          <FormComponent
            key={sheet.mode === "edit" ? sheet.item.id : "create"}
            initial={sheet.mode === "edit" ? sheet.item : undefined}
            onSuccess={handleSuccess}
            onCancel={() => setSheet({ mode: "closed" })}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
