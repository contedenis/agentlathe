import {
  createAgentUIStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
  type UIMessage,
} from "ai";
import { buildProvider, runTimeout } from "./helpers";

export { tool as builderTool } from "ai";

const BUILDER_MAX_STEPS = 24;
const OUT_OF_TIME = "The builder exceeded its time limit.";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function streamBuilderForUI(options: {
  model: string;
  instructions: string;
  tools: ToolSet;
  messages: UIMessage[];
  abortSignal?: AbortSignal;
}): Promise<Response> {
  const { model, instructions, tools, messages, abortSignal } = options;
  const timeout = AbortSignal.timeout(runTimeout().totalMs);
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  abortSignal?.addEventListener("abort", finish, { once: true });

  const agent = new ToolLoopAgent({
    model: buildProvider(model),
    instructions,
    tools,
    stopWhen: stepCountIs(BUILDER_MAX_STEPS),
  });
  const toolErrors = new Set<unknown>();
  const agentStream = await createAgentUIStream({
    agent,
    uiMessages: messages,
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, timeout])
      : timeout,
    generateMessageId: () => crypto.randomUUID(),
    onEnd: finish,
    experimental_transform: () =>
      new TransformStream({
        transform(part, controller) {
          if (part.type === "tool-error") toolErrors.add(part.error);
          else if (part.type === "tool-call" && part.invalid)
            toolErrors.add(part.error);
          controller.enqueue(part);
        },
      }),
    onError: (error) => {
      if (!toolErrors.has(error)) finish();
      return messageOf(error);
    },
  });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.merge(agentStream);
      await finished;
      if (timeout.aborted)
        writer.write({ type: "error", errorText: OUT_OF_TIME });
    },
    onError: messageOf,
  });
  return createUIMessageStreamResponse({ stream });
}
