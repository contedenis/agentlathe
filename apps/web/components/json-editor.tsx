"use client";

import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { WandSparklesIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--primary)" },
  { tag: tags.string, color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--info)" },
  { tag: tags.separator, color: "var(--muted-foreground)" },
  { tag: [tags.brace, tags.squareBracket], color: "var(--foreground)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 12px", caretColor: "var(--primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 24%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": {
    padding: "6px 8px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    borderLeft: "3px solid var(--destructive)",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
});

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  searchKeymap: false,
};

function optionalJsonLinter() {
  const base = jsonParseLinter();
  return (view: EditorView) =>
    view.state.doc.toString().trim() === "" ? [] : base(view);
}

const extensions = [
  json(),
  syntaxHighlighting(jsonHighlightStyle),
  linter(optionalJsonLinter()),
  lintGutter(),
  EditorView.lineWrapping,
  editorTheme,
];

export function JsonEditor({
  value,
  onChange,
  minHeight = "8rem",
  maxHeight = "24rem",
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "done" | "invalid">("idle");
  const viewRef = useRef<EditorView | null>(null);

  function format() {
    try {
      const formatted = JSON.stringify(JSON.parse(value), null, 2);
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: formatted },
        });
      } else {
        onChange(formatted);
      }
      setStatus("done");
    } catch {
      setStatus("invalid");
    } finally {
      setTimeout(() => setStatus("idle"), 1200);
    }
  }

  return (
    <div
      className={cn("overflow-hidden rounded-lg border bg-muted/30", className)}
    >
      <div className="flex items-center justify-end border-b px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={format}
          className={cn(
            "text-muted-foreground hover:text-foreground",
            status === "invalid" && "text-destructive hover:text-destructive",
          )}
        >
          <WandSparklesIcon />
          {status === "done"
            ? "Formatted"
            : status === "invalid"
              ? "Invalid JSON"
              : "Format"}
        </Button>
      </div>
      <CodeMirror
        value={value}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        theme="none"
        placeholder={placeholder}
        basicSetup={basicSetup}
        extensions={extensions}
        minHeight={minHeight}
        maxHeight={maxHeight}
      />
    </div>
  );
}
