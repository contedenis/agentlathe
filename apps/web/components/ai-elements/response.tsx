import type { ComponentProps } from "react";
import { memo } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export type ResponseProps = ComponentProps<typeof Streamdown>;

const rehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [
    (defaultRehypePlugins.harden as [unknown, object])[0],
    { allowedImagePrefixes: [], allowedLinkPrefixes: ["*"] },
  ],
] as ComponentProps<typeof Streamdown>["rehypePlugins"];

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      rehypePlugins={rehypePlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
