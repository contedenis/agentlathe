export {
  openAIMessagesToModelMessages,
  toOpenAIChatCompletion,
  toOpenAIChatCompletionStream,
} from "@agentlathe/openai-server";
// Re-exported so apps/web can validate the chat body without depending on "ai".
export type { UIMessage } from "ai";
export { safeValidateUIMessages } from "ai";
export { buildHeadlessToolApproval } from "./approval";
export {
  type AgentProgress,
  generateWithApprovals,
  type PendingApproval,
} from "./generate-with-approvals";
export { PROVIDER_BASE_URL } from "./helpers";
export { compileInputSchema } from "./input-schema";
export { type AgentRow, loadActiveAgent } from "./loaders";
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
