"use client";

import {
  DEFAULT_CRITERION_FAIL_BELOW,
  DEFAULT_CRITERION_PASS_ABOVE,
} from "@agentlathe/db/constants";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Loader2Icon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/mutate";
import type { AgentCriterion } from "@/lib/queries";
import {
  describePreview,
  type PreviewDraft,
  type PreviewNote,
  type PreviewState,
  useCriterionPreview,
} from "@/lib/use-criterion-preview";
import { cn } from "@/lib/utils";

type Values = {
  question: string;
  passDescription: string;
  failDescription: string;
  appliesWhen: string;
  failBelow: string;
  passAbove: string;
};

export type CriterionPrefill = {
  failDescription: string;
  sourceFixDraftId: string;
};

function initialValues(
  criterion: AgentCriterion | null | undefined,
  prefill: CriterionPrefill | null | undefined,
): Values {
  return {
    question: criterion?.question ?? "",
    passDescription: criterion?.passDescription ?? "",
    failDescription:
      criterion?.failDescription ?? prefill?.failDescription ?? "",
    appliesWhen: criterion?.appliesWhen ?? "",
    failBelow: String(criterion?.failBelow ?? DEFAULT_CRITERION_FAIL_BELOW),
    passAbove: String(criterion?.passAbove ?? DEFAULT_CRITERION_PASS_ABOVE),
  };
}

function parseThreshold(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function thresholdProblem(values: Values): string | null {
  const failBelow = parseThreshold(values.failBelow);
  const passAbove = parseThreshold(values.passAbove);
  if (failBelow === null || passAbove === null)
    return "Thresholds must be numbers between 0 and 1.";
  if (failBelow > passAbove)
    return "“Fail below” can't be greater than “Pass above”.";
  return null;
}

function orNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function toDraft(values: Values): PreviewDraft | null {
  const question = values.question.trim();
  if (question === "" || thresholdProblem(values)) return null;
  return {
    question,
    passDescription: orNull(values.passDescription),
    failDescription: orNull(values.failDescription),
    appliesWhen: orNull(values.appliesWhen),
    failBelow: Number(values.failBelow),
    passAbove: Number(values.passAbove),
  };
}

const NOTE_STYLE: Record<PreviewNote["tone"], string> = {
  good: "text-success",
  warning: "text-warning",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

function PreviewStatus({
  state,
  hasQuestion,
  thresholdsInvalid,
}: {
  state: PreviewState;
  hasQuestion: boolean;
  thresholdsInvalid: boolean;
}) {
  let content: ReactNode;
  if (state.kind === "loading") {
    content = (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        Checking…
      </span>
    );
  } else if (state.kind === "done") {
    const note = describePreview(state.result);
    content = (
      <span className={cn("flex items-start gap-1.5", NOTE_STYLE[note.tone])}>
        {note.tone === "good" && (
          <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
        )}
        {note.tone === "warning" && (
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        )}
        {note.text}
      </span>
    );
  } else if (state.kind === "failed") {
    content = (
      <span className="text-muted-foreground">
        Could not check: {state.message}
      </span>
    );
  } else {
    content = (
      <span className="text-muted-foreground">
        {thresholdsInvalid
          ? "Fix the thresholds to check this against the run it came from."
          : hasQuestion
            ? "Change a field to check it against the run this came from."
            : "Fill in the question to check it against the run this came from."}
      </span>
    );
  }
  return (
    <output
      aria-live="polite"
      className="block rounded-lg border bg-muted/30 px-3 py-2 text-xs"
    >
      {content}
    </output>
  );
}

function CriterionForm({
  agentId,
  criterion,
  prefill,
  previewRunId,
  questionRef,
  onOpenChange,
}: {
  agentId: string;
  criterion: AgentCriterion | null | undefined;
  prefill: CriterionPrefill | null | undefined;
  previewRunId: string | null;
  questionRef: RefObject<HTMLTextAreaElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState(() => initialValues(criterion, prefill));
  const [showApplies, setShowApplies] = useState(
    Boolean(criterion?.appliesWhen),
  );
  const [advancedOpen] = useState(
    () =>
      values.failBelow !== String(DEFAULT_CRITERION_FAIL_BELOW) ||
      values.passAbove !== String(DEFAULT_CRITERION_PASS_ABOVE),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useCriterionPreview(previewRunId);

  function update(patch: Partial<Values>) {
    const next = { ...values, ...patch };
    setValues(next);
    preview.schedule(toDraft(next));
  }

  const problem = thresholdProblem(values);
  const hasPass = values.passDescription.trim() !== "";
  const hasFail = values.failDescription.trim() !== "";
  const canSave = !pending && values.question.trim() !== "" && !problem;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setError(null);
    setPending(true);
    const body = {
      question: values.question.trim(),
      passDescription: orNull(values.passDescription),
      failDescription: orNull(values.failDescription),
      appliesWhen: showApplies ? orNull(values.appliesWhen) : null,
      failBelow: Number(values.failBelow),
      passAbove: Number(values.passAbove),
    };
    try {
      if (criterion) {
        await apiRequest(`/api/agents/${agentId}/criteria/${criterion.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success("Criterion updated.");
      } else {
        await apiRequest(`/api/agents/${agentId}/criteria`, {
          method: "POST",
          body: JSON.stringify(
            prefill
              ? { ...body, sourceFixDraftId: prefill.sourceFixDraftId }
              : body,
          ),
        });
        toast.success("Criterion created.");
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="flex min-h-0 flex-col gap-4"
    >
      <DialogHeader>
        <DialogTitle>
          {criterion ? "Edit criterion" : "Add criterion"}
        </DialogTitle>
        <DialogDescription>
          {prefill
            ? "Turn this note into a yes/no question the judge answers about every run."
            : "A yes/no question the judge answers about every run."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="criterion-question">Question</Label>
        <Textarea
          id="criterion-question"
          ref={questionRef}
          value={values.question}
          onChange={(e) => update({ question: e.target.value })}
          placeholder="Did the assistant avoid promising a refund without confirmation?"
        />
        <p className="text-xs text-muted-foreground">
          Phrase it so that yes means the run did well.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="criterion-pass">Passes when</Label>
            <Textarea
              id="criterion-pass"
              value={values.passDescription}
              onChange={(e) => update({ passDescription: e.target.value })}
              placeholder="The assistant asks for confirmation before any refund."
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="criterion-fail">Fails when</Label>
            <Textarea
              id="criterion-fail"
              value={values.failDescription}
              onChange={(e) => update({ failDescription: e.target.value })}
              placeholder="The assistant promises a refund on its own."
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Describing both sides makes the judge much more reliable.
        </p>
        {hasPass !== hasFail && (
          <p className="text-xs text-warning">
            Both together work best: the judge only treats them as criteria when
            both are filled in.
          </p>
        )}
      </div>

      {showApplies ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="criterion-applies">Only evaluate when</Label>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setShowApplies(false);
                update({ appliesWhen: "" });
              }}
            >
              Remove condition
            </Button>
          </div>
          <Textarea
            id="criterion-applies"
            value={values.appliesWhen}
            onChange={(e) => update({ appliesWhen: e.target.value })}
            placeholder="Did the customer ask for a refund?"
          />
          <p className="text-xs text-muted-foreground">
            Runs where this is 'no' are marked not applicable.
          </p>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowApplies(true)}
        >
          <PlusIcon />
          Add a condition
        </Button>
      )}

      <Collapsible defaultOpen={advancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 font-mono text-[11px] tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground">
          Advanced
          <ChevronDownIcon className="size-4 transition-transform group-data-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="-mx-1 px-1 pb-1">
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="criterion-fail-below">Fail below</Label>
                <Input
                  id="criterion-fail-below"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={values.failBelow}
                  onChange={(e) => update({ failBelow: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="criterion-pass-above">Pass above</Label>
                <Input
                  id="criterion-pass-above"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={values.passAbove}
                  onChange={(e) => update({ passAbove: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Scores between them are flagged for review.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {problem && <p className="-mt-2 text-xs text-destructive">{problem}</p>}

      {previewRunId && (
        <PreviewStatus
          state={preview.state}
          hasQuestion={values.question.trim() !== ""}
          thresholdsInvalid={problem !== null}
        />
      )}

      <DialogFooter>
        {error && (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {pending ? "Saving..." : criterion ? "Save changes" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CriterionDialog({
  agentId,
  open,
  onOpenChange,
  criterion,
  prefill,
  previewRunId,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  criterion?: AgentCriterion | null;
  prefill?: CriterionPrefill | null;
  previewRunId?: string | null;
}) {
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={questionRef}
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <CriterionForm
          key={criterion?.id ?? prefill?.sourceFixDraftId ?? "new"}
          agentId={agentId}
          criterion={criterion}
          prefill={prefill}
          previewRunId={previewRunId ?? criterion?.sourceRunId ?? null}
          questionRef={questionRef}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
