"use client";

import { type HTMLAttributes, useEffect, useState } from "react";
import {
  type BundledLanguage,
  codeToHtml,
  type ShikiTransformer,
} from "shiki/bundle/web";
import { cn } from "@/lib/utils";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
) {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : [];

  return await Promise.all([
    codeToHtml(code, { lang: language, theme: "one-light", transformers }),
    codeToHtml(code, { lang: language, theme: "one-dark-pro", transformers }),
  ]);
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState("");
  const [darkHtml, setDarkHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language, showLineNumbers).then(([light, dark]) => {
      if (!cancelled) {
        setHtml(light);
        setDarkHtml(dark);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, showLineNumbers]);

  const lightPane = (
    <div
      className="max-h-96 overflow-auto dark:hidden [&_code]:font-mono [&_code]:text-sm [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:break-words [&>pre]:whitespace-pre-wrap [&>pre]:text-sm [&>pre]:text-foreground!"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output from our own code, not user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
  const darkPane = (
    <div
      className="hidden max-h-96 overflow-auto dark:block [&_code]:font-mono [&_code]:text-sm [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:break-words [&>pre]:whitespace-pre-wrap [&>pre]:text-sm [&>pre]:text-foreground!"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output from our own code, not user input.
      dangerouslySetInnerHTML={{ __html: darkHtml }}
    />
  );

  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden rounded-lg border bg-background text-foreground",
        className,
      )}
      {...props}
    >
      <div className="relative">
        {lightPane}
        {darkPane}
        {children && (
          <div className="absolute top-2 right-2 flex items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </div>
  );
};
