export {
  openAIMessagesToModelMessages,
  toOpenAIChatCompletion,
  toOpenAIChatCompletionStream,
} from "@agentlathe/openai-server";
// Re-exported so apps/web can validate the chat body without depending on "ai".
export type { UIMessage } from "ai";
export { safeValidateUIMessages } from "ai";
export {
  buildHeadlessToolApproval,
  buildScheduledToolApproval,
} from "./approval";
export {
  CompactionError,
  type CompactionPlan,
  planCompaction,
} from "./compaction";
export type { RunContext } from "./context";
export {
  type AgentProgress,
  generateWithApprovals,
  type PendingApproval,
} from "./generate-with-approvals";
export { buildAuth, getContextLimit, PROVIDER_BASE_URL } from "./helpers";
export { compileInputSchema } from "./input-schema";
export { type AgentRow, loadActiveAgent } from "./loaders";
export {
  type MemoryPartitionRef,
  type MemoryStoreView,
  renderMemorySection,
} from "./memory";
export {
  type AgentRunStats,
  createRunRecorder,
  type RunRecorder,
  type RunRecorderOptions,
} from "./recording";
export { buildAgentRuntime } from "./runtime";
export { streamAgentForUI } from "./stream-ui";
export { discoverMcpTools } from "./tools";
export type { AgentVersionSnapshot } from "./versions";
