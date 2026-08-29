import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      title="Not found"
      description="The page you are looking for does not exist or was moved."
      action={
        <Link href="/" className={buttonVariants()}>
          Go home
        </Link>
      }
    />
  );
}
