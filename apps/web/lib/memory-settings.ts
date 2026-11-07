import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_MEMORY_PURPOSES,
  MAX_MEMORY_CHAR_LIMIT,
  type MemoryScope,
  RUN_LABEL_MAX_LENGTH,
} from "@agentlathe/db/constants";

export const MIN_MEMORY_CHAR_LIMIT = 1000;

export type MemorySettings = {
  purpose: string;
  charLimit: string;
  requireApproval: boolean;
};

type StoredSettings = {
  purpose: string;
  charLimit: number;
  requireApproval: boolean;
};

export function memorySettingsOf(stored: StoredSettings): MemorySettings {
  return {
    purpose: stored.purpose,
    charLimit: String(stored.charLimit),
    requireApproval: stored.requireApproval,
  };
}

export function memorySettingsError(settings: MemorySettings): string | null {
  const limit = Number(settings.charLimit);
  if (
    !Number.isInteger(limit) ||
    limit < MIN_MEMORY_CHAR_LIMIT ||
    limit > MAX_MEMORY_CHAR_LIMIT
  )
    return `A memory's limit is a whole number from ${MIN_MEMORY_CHAR_LIMIT.toLocaleString("en-US")} to ${MAX_MEMORY_CHAR_LIMIT.toLocaleString("en-US")}.`;
  if (!settings.purpose.trim()) return "A memory needs a purpose.";
  return null;
}

export function memorySettingsBody(settings: MemorySettings) {
  return {
    purpose: settings.purpose.trim(),
    charLimit: Number(settings.charLimit),
    requireApproval: settings.requireApproval,
  };
}

export const MEMORY_TYPES = [
  "none",
  "agent",
  "agent_subject",
  "custom",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type AgentMemoryConfig = {
  type: MemoryType;
  settings: Record<MemoryScope, MemorySettings>;
  memoryKey: string;
};

function defaultSettings(scope: MemoryScope): MemorySettings {
  return memorySettingsOf({
    purpose: scope === "custom" ? "" : DEFAULT_MEMORY_PURPOSES[scope],
    charLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    requireApproval: false,
  });
}

export const EMPTY_MEMORY_CONFIG: AgentMemoryConfig = {
  type: "none",
  settings: {
    agent: defaultSettings("agent"),
    agent_subject: defaultSettings("agent_subject"),
    custom: defaultSettings("custom"),
  },
  memoryKey: "",
};

export function memoryConfigOf(
  stores: Array<
    StoredSettings & {
      scope: MemoryScope;
      isActive: boolean;
      memoryKey: string | null;
    }
  >,
): AgentMemoryConfig {
  const settingsOf = (scope: MemoryScope) => {
    const store = stores.find((candidate) => candidate.scope === scope);
    return store ? memorySettingsOf(store) : defaultSettings(scope);
  };
  const active = stores.find((store) => store.isActive);
  return {
    type: active?.scope ?? "none",
    settings: {
      agent: settingsOf("agent"),
      agent_subject: settingsOf("agent_subject"),
      custom: settingsOf("custom"),
    },
    memoryKey:
      stores.find((store) => store.scope === "custom")?.memoryKey ?? "",
  };
}

export function memoryConfigError(config: AgentMemoryConfig): string | null {
  if (config.type === "none") return null;
  if (config.type === "custom") {
    const key = config.memoryKey.trim();
    if (!key) return "Set the x-memory-key value the agent expects.";
    if (key.length > RUN_LABEL_MAX_LENGTH)
      return `The x-memory-key value holds at most ${RUN_LABEL_MAX_LENGTH} characters.`;
  }
  return memorySettingsError(config.settings[config.type]);
}

export function memoryConfigBody(config: AgentMemoryConfig) {
  if (config.type === "none") return { type: config.type };
  return {
    type: config.type,
    settings: memorySettingsBody(config.settings[config.type]),
    ...(config.type === "custom" ? { memoryKey: config.memoryKey.trim() } : {}),
  };
}
