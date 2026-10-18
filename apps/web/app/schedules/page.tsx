import { SchedulesList } from "@/components/schedules-list";
import { listAgents } from "@/lib/queries";
import { getSchedulerStatus, listSchedules } from "@/lib/queries-schedules";

export default async function SchedulesPage() {
  const [schedules, agents, scheduler] = await Promise.all([
    listSchedules(),
    listAgents(),
    getSchedulerStatus(),
  ]);
  return (
    <SchedulesList
      schedules={schedules}
      agents={agents.map(({ id, name }) => ({ id, name }))}
      schedulerSecondsAgo={scheduler.secondsAgo}
    />
  );
}
