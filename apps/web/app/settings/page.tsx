import { getSettings } from "@agentlathe/db";
import { PageHeader } from "@/components/page-header";
import { TrackingToggles } from "@/components/tracking-toggles";
import { judgeHost } from "@/lib/judge";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Workshop · settings"
        title="Settings"
        description="What gets recorded, how long it is kept, and which model judges runs."
      />
      <section className="max-w-xl rounded-lg border bg-card p-5">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.01em]">
          What to record
        </h2>
        <p className="mt-1 mb-4 text-[12.5px] text-muted-foreground">
          One row per run. Messages are stored too: always for the Playground
          and schedules, and for API and MCP calls only on agents that opt in.
        </p>
        <TrackingToggles initial={settings} judgeHost={judgeHost()} />
      </section>
    </div>
  );
}
