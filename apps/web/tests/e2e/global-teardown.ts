import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = join(__dirname, "./.state.json");

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

export default async function globalTeardown() {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
    containerId?: string;
    appPid?: number;
    toolServerPid?: number;
    persistent?: boolean;
  };
  if (state.persistent) return;

  killTree(state.appPid);
  killTree(state.toolServerPid);
  if (state.containerId) {
    try {
      execSync(`docker rm -f ${state.containerId}`, { stdio: "ignore" });
    } catch {}
  }
  unlinkSync(STATE_FILE);
}
