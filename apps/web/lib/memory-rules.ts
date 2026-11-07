import type { MemoryScope } from "@agentlathe/db/constants";

export const MEMORY_SCOPE_LABEL: Record<MemoryScope, string> = {
  agent: "Agent memory",
  agent_subject: "Agent memory per subject",
  custom: "Agent memory with a custom key",
};

export const MEMORY_SCOPE_DESCRIPTION: Record<MemoryScope, string> = {
  agent: "One memory, shared by all the agent's runs.",
  agent_subject:
    "One memory per x-subject-id (a customer, an account, a ticket), kept by this agent only.",
  custom:
    "One memory, used only when the request sends x-memory-key with the value set here. Without it, or with another value, the run goes without memory and says so.",
};
