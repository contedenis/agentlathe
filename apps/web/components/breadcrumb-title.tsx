"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

type Entry = { path: string; name: string } | null;

const BreadcrumbTitleContext = createContext<{
  entry: Entry;
  setEntry: (entry: Entry) => void;
}>({ entry: null, setEntry: () => {} });

export function BreadcrumbTitleProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Entry>(null);
  return (
    <BreadcrumbTitleContext.Provider value={{ entry, setEntry }}>
      {children}
    </BreadcrumbTitleContext.Provider>
  );
}

// Tied to the path that published it, or a stale name labels the next route for a frame.
export function useBreadcrumbTitle(): string | undefined {
  const pathname = usePathname();
  const { entry } = useContext(BreadcrumbTitleContext);
  return entry?.path === pathname ? entry.name : undefined;
}

export function BreadcrumbTitle({ name }: { name: string }) {
  const pathname = usePathname();
  const { setEntry } = useContext(BreadcrumbTitleContext);

  useEffect(() => {
    setEntry({ path: pathname, name });
    return () => setEntry(null);
  }, [pathname, name, setEntry]);

  return null;
}
