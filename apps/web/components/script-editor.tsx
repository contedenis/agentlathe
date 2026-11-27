"use client";

import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { basicSetup, editorTheme } from "@/components/json-editor";
import { cn } from "@/lib/utils";

const scriptHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)" },
  { tag: tags.string, color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--info)" },
  { tag: tags.comment, color: "var(--muted-foreground)" },
]);

const extensions = [
  javascript(),
  syntaxHighlighting(scriptHighlightStyle),
  EditorView.lineWrapping,
  editorTheme,
];

export function ScriptEditor({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg border bg-muted/30", className)}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme="none"
        placeholder={placeholder}
        basicSetup={basicSetup}
        extensions={extensions}
        minHeight="8rem"
        maxHeight="24rem"
        aria-label="Script"
      />
    </div>
  );
}
