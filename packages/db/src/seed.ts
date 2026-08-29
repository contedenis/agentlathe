import { isMain } from "./cli-entry";
import { db } from "./client";
import { agentSlug } from "./naming";
import { agentSkills, agents, agentTools, skills, tools } from "./schema";

const AGENT_NAME = "General assistant";
const SKILL_NAME = "Tone guide";
const TOOL_NAME = "Test webhook";
const MODEL = process.env.SEED_MODEL ?? "~deepseek/deepseek-v4-flash-latest";

export async function seed() {
  await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        name: AGENT_NAME,
        slug: agentSlug(AGENT_NAME),
        description: "Example agent created by the initial seed.",
        model: MODEL,
        systemPrompt:
          "You are a general assistant, helpful and concise. Reply in English.",
      })
      .onConflictDoNothing()
      .returning();

    if (!agent) {
      console.log(`Seed: agent "${AGENT_NAME}" already exists, nothing to do.`);
      return;
    }

    const [[skill], [tool]] = await Promise.all([
      tx
        .insert(skills)
        .values({
          name: SKILL_NAME,
          description: "How to answer in a clear and direct tone.",
          content:
            "- Answer in short sentences.\n- Avoid unnecessary jargon.\n- If you do not know something, say so.",
        })
        .returning(),
      tx
        .insert(tools)
        .values({
          name: TOOL_NAME,
          description:
            "Sends a test POST to httpbin to verify the HTTP integration.",
          endpoint: "https://httpbin.org/post",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "Text to send in the POST body",
              },
            },
            required: ["message"],
          },
          needsApproval: false,
        })
        .returning(),
    ]);

    await Promise.all([
      tx.insert(agentSkills).values({ agentId: agent.id, skillId: skill.id }),
      tx.insert(agentTools).values({ agentId: agent.id, toolId: tool.id }),
    ]);

    console.log(
      `Seed: agent "${AGENT_NAME}" created with its skill and tool (model: ${MODEL}).`,
    );
  });
}

if (isMain(import.meta.url)) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
