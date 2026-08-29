# @agentlathe/openai-server

> Serve an OpenAI-compatible Chat Completions endpoint from an AI SDK agent.

[`@ai-sdk/openai-compatible`](https://ai-sdk.dev/providers/openai-compatible-providers) covers one direction: **consuming** any OpenAI-compatible endpoint in a line of code. This package covers the other one — turning an [AI SDK](https://ai-sdk.dev) result or stream **into** that wire format, so your own agent can be pointed at by any OpenAI client.

There is no helper for this in the SDK. This is the code that was written for [agentlathe](../../README.md)'s `/v1` surface, extracted because the problem is not specific to it.

## What it does

Three functions, no runtime dependencies beyond `ai` as a peer:

| Export | Direction | Purpose |
| --- | --- | --- |
| `toOpenAIChatCompletion(result, model, opts?)` | out | An AI SDK generate result → a blocking `chat.completion` object |
| `toOpenAIChatCompletionStream(fullStream, model, opts, onDone?, onCancel?)` | out | An AI SDK `fullStream` → an SSE `Response` of `chat.completion.chunk` frames |
| `openAIMessagesToModelMessages(messages)` | in | An OpenAI `messages` array → AI SDK `ModelMessage[]` |

## What is actually hard about it

The wire format is documented; matching it against a *tool-calling agent loop* is where the work is.

- **`tool_calls` deltas are index-addressed.** OpenAI streams a tool call as fragments carrying an `index`, and clients reassemble by that index — not by id. Tool input arrives from the SDK as `tool-input-delta` fragments that have to be accumulated per call and re-emitted under a stable index, with a fallback to `JSON.stringify(part.input)` for providers that never send deltas at all.
- **Only unresolved calls belong in the response.** A tool the agent already executed server-side must not be reported as a pending `tool_call`, or the client will try to answer a call that was answered. Same for a call the loop walked away from after a denial or a tool error.
- **`finish_reason` is a different vocabulary** from the SDK's `finishReason`, and getting `tool_calls` wrong there breaks client loops rather than producing a visible error.

## Status

Extracted from a single-maintainer project and not published to npm. Copy it, vendor it, or take the ideas — it is MIT. If the AI SDK ever grows a first-party helper for this, that is strictly better and this should go away.
