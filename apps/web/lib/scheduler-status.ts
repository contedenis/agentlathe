export const SCHEDULER_STALE_SECONDS = 90;

export function schedulerRunning(secondsAgo: number | null): boolean {
  return secondsAgo !== null && secondsAgo < SCHEDULER_STALE_SECONDS;
}
