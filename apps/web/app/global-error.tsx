"use client";

import Link from "next/link";
import { useEffect } from "react";
import "./globals.css";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        <div className="flex min-h-screen items-center justify-center p-8">
          <EmptyState
            title="Something went wrong"
            description="An unexpected error occurred. You can retry or go back home."
            action={
              <div className="flex gap-2">
                <Button onClick={reset}>Retry</Button>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/" />}
                >
                  Go home
                </Button>
              </div>
            }
          />
        </div>
      </body>
    </html>
  );
}
