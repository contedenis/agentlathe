"use client";

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { fmt } from "@/lib/format";
import { useTokenCount } from "@/lib/use-token-count";

const HEADING_RE = /^#{1,6}\s/;

const headingLine = Decoration.line({ class: "cm-tp-heading" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (HEADING_RE.test(line.text)) {
        builder.add(line.from, line.from, headingLine);
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": { padding: "16px 20px", caretColor: "var(--primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 24%, transparent)",
  },
  ".cm-tp-heading": { color: "var(--primary)", fontWeight: "500" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
});

const editorExtensions = [
  EditorView.lineWrapping,
  editorTheme,
  highlightPlugin,
];

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  bracketMatching: false,
  closeBrackets: false,
  autocompletion: false,
  searchKeymap: false,
};

export function SystemPromptCanvas({
  open,
  onOpenChange,
  value,
  onChange,
  model,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  model: string;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const chars = value.length;
  const { tokens, loading } = useTokenCount(value, model);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0"
        style={{
          width: fullscreen ? "100vw" : "min(680px, 100vw)",
          maxWidth: "100vw",
        }}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Agent · system prompt
            </p>
            <SheetTitle className="mt-0.5 text-base">Prompt editor</SheetTitle>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setFullscreen((prev) => !prev)}
              aria-label={fullscreen ? "Restore size" : "Full screen"}
            >
              {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label="Close editor"
            >
              <XIcon />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b bg-muted/30 px-4 py-2 font-mono text-[11px] text-muted-foreground">
          <span className={loading ? "opacity-50" : undefined}>
            tokens <b className="font-medium text-primary">~{fmt(tokens)}</b>
          </span>
          <span>
            characters{" "}
            <b className="font-medium text-foreground">{fmt(chars)}</b>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeMirror
            value={value}
            onChange={(next) => onChange(next)}
            height="100%"
            theme="none"
            placeholder="Write the agent instructions…"
            basicSetup={basicSetup}
            extensions={editorExtensions}
            className="h-full text-left"
          />
        </div>

        <div className="flex items-center gap-3 border-t p-3">
          <p className="text-[11px] text-muted-foreground">
            Changes are stored when you save the agent.
          </p>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
