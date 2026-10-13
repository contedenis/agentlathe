import Link from "next/link";
import { Hint, MetricHint } from "@/components/metric-hint";
import { PassRateChart } from "@/components/metrics-charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VersionChangesDialog } from "@/components/version-dialogs";
import {
  type AgentEvaluation,
  type EvaluationStat,
  type EvaluationVersionDelta,
  MIN_EVALUATION_SAMPLE,
} from "@/lib/metrics-assembly";

const MAX_VERSION_COLUMNS = 8;

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function Delta({ delta }: { delta: EvaluationVersionDelta }) {
  if (delta.kind === "none") return null;
  if (delta.kind === "small_sample")
    return (
      <Hint
        trigger={
          <span className="text-[11px] text-muted-foreground">
            too few verdicts to compare
          </span>
        }
      >
        <span>
          One of the two versions has fewer than {MIN_EVALUATION_SAMPLE} judged
          verdicts for this criterion, too few to call a change.
        </span>
      </Hint>
    );
  if (delta.points === 0)
    return (
      <span className="text-[11px] text-muted-foreground">
        no change vs the previous version
      </span>
    );
  return (
    <span
      className={`text-[11px] ${delta.points > 0 ? "text-success" : "text-warning"}`}
    >
      {delta.points > 0 ? "↑" : "↓"} {Math.abs(delta.points)} pts vs the
      previous version
    </span>
  );
}

function Cell({ stat }: { stat: EvaluationStat }) {
  if (stat.passRate === null && stat.needsReview === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <>
      <div className="font-medium">
        {stat.passRate === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          percent(stat.passRate)
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">
        n={stat.judged}
        {stat.needsReview > 0 && (
          <span className="text-warning"> · {stat.needsReview} to review</span>
        )}
      </div>
    </>
  );
}

export function AgentEvaluationMetrics({
  evaluation,
  agentId,
  period,
}: {
  evaluation: AgentEvaluation;
  agentId: string;
  period: string;
}) {
  if (!evaluation.hasVerdicts)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Evaluation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {evaluation.activeCriteria === 0
              ? "This agent has no active criteria, so its runs are not being judged."
              : `No run was judged against its criteria in ${period}.`}{" "}
            <Link
              href={`/agents/${agentId}`}
              className="text-foreground hover:text-primary"
            >
              Manage criteria on the agent page
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );

  const { versions, rows, agreement, markers } = evaluation;
  const hidden = Math.max(0, versions.length - MAX_VERSION_COLUMNS);
  const shownVersions = versions.slice(hidden);
  const hasRates = evaluation.points.some((point) =>
    evaluation.series.some((entry) => point[entry.key] !== null),
  );
  const resolved = agreement.resolvedAsPass + agreement.resolvedAsFail;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Evaluation by agent version</CardTitle>
          <p className="text-sm text-muted-foreground">
            Pass rate of each criterion for the runs of every agent version in{" "}
            {period}, ordered by when each version last ran. Your reviews count
            over the judge's verdicts.
            {evaluation.inactiveCriteria > 0 &&
              ` ${evaluation.inactiveCriteria} inactive ${evaluation.inactiveCriteria === 1 ? "criterion is" : "criteria are"} not shown.`}
            {hidden > 0 &&
              ` Showing the ${MAX_VERSION_COLUMNS} most recent versions.`}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Criterion</TableHead>
                {shownVersions.map((version) => (
                  <TableHead key={version.id}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono">{version.shortHash}</span>
                      {version.newest && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                          newest
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-normal text-muted-foreground">
                      first seen {version.createdAt.toLocaleDateString("en-US")}
                    </div>
                    <div className="text-[11px] font-normal text-muted-foreground">
                      last run {version.lastRunAt.toLocaleDateString("en-US")}
                    </div>
                    {version.changes && (
                      <div className="flex max-w-56 flex-col items-start text-[11px] font-normal whitespace-normal">
                        <span className="text-foreground">
                          {version.changes.diff.summary}
                        </span>
                        <VersionChangesDialog
                          shortHash={version.shortHash}
                          previousShortHash={version.changes.previousShortHash}
                          changes={version.changes.diff}
                        />
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-72 whitespace-normal font-medium">
                    {row.question}
                  </TableCell>
                  {row.cells.slice(hidden).map((stat, index) => {
                    const version = shownVersions[index];
                    return (
                      <TableCell
                        key={version.id}
                        className={version.newest ? "bg-primary/5" : undefined}
                      >
                        <Cell stat={stat} />
                        {version.newest && <Delta delta={row.delta} />}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            <MetricHint label="How to read it">
              <span>
                The rate is pass over pass plus fail. n is how many verdicts it
                is based on; "to review" are the judge's unsure ones that nobody
                has resolved yet and are left out of the rate.
              </span>
              <span>
                The change next to the newest version only appears when both it
                and the previous one have at least {MIN_EVALUATION_SAMPLE}{" "}
                judged verdicts.
              </span>
              <span>
                A version that ran in several periods, for example after
                reverting a change, is merged into one column, and the newest is
                the one that ran most recently.
              </span>
              <span>
                Under each version, what changed compares it with the column to
                its left, the same pair the change in points compares.
              </span>
              <span>
                Only verdicts for the criterion's current question count:
                editing the question starts a fresh rate.
              </span>
            </MetricHint>
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pass rate over time</CardTitle>
            <p className="text-sm text-muted-foreground">
              Daily pass rate per criterion, only on days with judged verdicts.
              Dashed lines mark the first run of a new agent version.
            </p>
          </CardHeader>
          <CardContent>
            {hasRates ? (
              <PassRateChart
                data={evaluation.points}
                series={evaluation.series}
                markers={markers}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No criterion has a pass or fail verdict in {period} yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Judge vs human</CardTitle>
            <p className="text-sm text-muted-foreground">
              How often your review confirms what the judge decided.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <div className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
                <MetricHint label="Agreement">
                  <span>
                    Among verdicts you reviewed where the judge had said pass or
                    fail: the share where you kept its verdict.
                  </span>
                </MetricHint>
              </div>
              {agreement.enough && agreement.agreementRate !== null ? (
                <>
                  <div className="mt-1.5 font-heading text-2xl">
                    {percent(agreement.agreementRate)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {agreement.agreed} of {agreement.judgedReviewed} reviewed
                    verdicts kept
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1.5 text-sm font-medium">
                    Not enough reviews yet
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {agreement.judgedReviewed} of {MIN_EVALUATION_SAMPLE}{" "}
                    reviewed verdicts needed.
                  </div>
                </>
              )}
            </div>
            <div className="border-t pt-3 text-sm">
              <div className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
                <MetricHint label="Unsure verdicts you resolved">
                  <span>
                    The judge could not decide and left these to you. This is
                    how you settled them.
                  </span>
                </MetricHint>
              </div>
              <div className="mt-1.5 text-muted-foreground">
                {resolved === 0
                  ? "None resolved yet."
                  : `${agreement.resolvedAsPass} as pass · ${agreement.resolvedAsFail} as fail`}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
