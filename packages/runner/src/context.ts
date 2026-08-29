export const MAX_DEPTH = 5;
export const MAX_SUB_AGENT_CALLS = 20;

// The SDK caps no depth or fan-out: that is the runner's job. The budget is shared by
// reference across the whole run tree, unlike callStack, which is copied per branch.
export type RuntimeCtx = {
  callStack: Set<string>;
  depth: number;
  subAgentBudget: { remaining: number };
};
