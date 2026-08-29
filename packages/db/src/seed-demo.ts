import { eq, inArray, or } from "drizzle-orm";
import { isMain } from "./cli-entry";
import { db } from "./client";
import { agentAskToolName, agentSlug } from "./naming";
import {
  agentMcpTools,
  agentSkills,
  agentSubAgents,
  agents,
  agentTools,
  mcpServers,
  skills,
  tools,
} from "./schema";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const ECHO = "https://httpbingo.org/post";
const MARKER = "General orchestrator";
const SEED_MODEL = process.env.SEED_MODEL;

const SKILLS = [
  {
    name: "Support tone",
    description: "How to talk to a user reporting a problem.",
    content:
      "- Acknowledge the problem before explaining anything.\n- Never promise deadlines you do not control.\n- Always close with a concrete next step.",
  },
  {
    name: "Concise answers",
    description: "Rules for answering without filler.",
    content:
      "- Three sentences at most unless detail is requested.\n- No preambles ('Sure, happy to help...').\n- If the answer is a value, return the value.",
  },
  {
    name: "Markdown formatting",
    description: "How to structure long answers.",
    content:
      "- Lists to enumerate, tables to compare.\n- Code blocks with the language declared.\n- Never more than two levels of nesting.",
  },
  {
    name: "Data analysis",
    description: "How to approach questions about numbers.",
    content:
      "- State your assumptions before calculating.\n- Tell correlation apart from causation.\n- If data is missing, ask for it instead of estimating.",
  },
  {
    name: "Code review",
    description: "What to look at when reviewing a change.",
    content:
      "- Correctness before style.\n- Point at the edge case that breaks, not personal preference.\n- If the change needs a test and has none, say so.",
  },
];

const TOOLS = [
  {
    name: "Check service status",
    description: "Returns the operational status of a service by name.",
    endpoint: ECHO,
    needsApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name" },
      },
      required: ["service"],
    },
  },
  {
    name: "Create ticket",
    description: "Opens a support ticket with a title and a priority.",
    endpoint: ECHO,
    needsApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["title", "priority"],
    },
  },
  {
    name: "Notify the team",
    description: "Sends a message to the team channel. Requires approval.",
    endpoint: ECHO,
    needsApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message: { type: "string" },
      },
      required: ["channel", "message"],
    },
  },
  {
    name: "Close ticket",
    description: "Closes an existing ticket. Requires approval.",
    endpoint: ECHO,
    needsApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        resolution: { type: "string" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "Convert currency",
    description: "Converts an amount between two currencies.",
    endpoint: ECHO,
    needsApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["amount", "from", "to"],
    },
  },
  {
    name: "Query metrics",
    description: "Returns the series of a metric over a date range.",
    endpoint: ECHO,
    needsApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90 },
      },
      required: ["metric"],
    },
  },
  {
    name: "Purge cache",
    description: "Invalidates the cache of an environment. Requires approval.",
    endpoint: ECHO,
    needsApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "string", enum: ["dev", "staging", "prod"] },
      },
      required: ["environment"],
    },
  },
];

const AGENTS = [
  {
    name: "Ticket classifier",
    description: "Reads a report and assigns it a category and a priority.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 8,
    systemPrompt:
      "You classify support reports. Return a category (bug, question, feature request, billing) and a priority (low, medium, high), with one line of justification. You do not solve the problem, you only classify it.",
    skills: ["Concise answers"],
    tools: ["Check service status"],
    subAgents: [],
  },
  {
    name: "Response writer",
    description: "Writes the final answer to the user.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 6,
    systemPrompt:
      "You write the answer the user is going to read. The diagnosis is already done: your job is to communicate it well, not to diagnose again.",
    skills: ["Support tone", "Markdown formatting"],
    tools: [],
    subAgents: [],
  },
  {
    name: "Support coordinator",
    description: "Resolves a support case end to end.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 20,
    systemPrompt:
      "You coordinate a support case. First classify it with the matching sub-agent, then decide whether a ticket has to be opened or the team notified, and finally delegate writing the answer. Do not write the final answer yourself.",
    skills: ["Support tone"],
    tools: ["Create ticket", "Notify the team", "Close ticket"],
    subAgents: ["Ticket classifier", "Response writer"],
  },
  {
    name: "Repository analyst",
    description: "Answers questions about GitHub repositories.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 15,
    systemPrompt:
      "You analyze GitHub repositories using the available tools. Always cite the concrete file or commit you are basing the answer on. If you find no evidence, say you found none.",
    skills: ["Code review", "Markdown formatting"],
    tools: [],
    subAgents: [],
    github: [
      "search_repositories",
      "get_file_contents",
      "list_commits",
      "search_code",
    ],
  },
  {
    name: "Data assistant",
    description: "Answers quantitative questions about the business.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 12,
    systemPrompt:
      "You answer questions about business metrics and numbers. State your assumptions before calculating and never invent data you do not have.",
    skills: ["Data analysis", "Concise answers"],
    tools: ["Query metrics", "Convert currency"],
    subAgents: [],
  },
  {
    name: MARKER,
    description: "Single entry point: routes to the right specialist.",
    model: "~deepseek/deepseek-v4-flash-latest",
    maxSteps: 25,
    systemPrompt:
      "You are the entry point. You identify what the request is about and route it to the right specialist. Do not answer what a specialist can answer; your value is in choosing well and in integrating what they return.",
    skills: ["Concise answers"],
    tools: ["Purge cache"],
    subAgents: ["Support coordinator", "Repository analyst", "Data assistant"],
  },
];

export async function seedDemo() {
  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, MARKER))
    .limit(1);
  if (existing) {
    console.log(`seed-demo: "${MARKER}" already exists, nothing to do.`);
    return;
  }

  const demoNames = AGENTS.map((agent) => agent.name);
  const demoSlugs = AGENTS.map((agent) => agentSlug(agent.name));
  const collisions = await db
    .select({ name: agents.name, slug: agents.slug })
    .from(agents)
    .where(
      or(inArray(agents.name, demoNames), inArray(agents.slug, demoSlugs)),
    );
  if (collisions.length > 0) {
    const details = collisions
      .map((row) => `"${row.name}" (slug "${row.slug}")`)
      .join(", ");
    throw new Error(
      `seed-demo: found existing agent(s) that collide with the demo set: ${details}. Rename or delete them before running seed:demo again.`,
    );
  }

  const [github] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.name, "GitHub"))
    .limit(1);

  await db.transaction(async (tx) => {
    const skillRows = await tx.insert(skills).values(SKILLS).returning();
    const toolRows = await tx.insert(tools).values(TOOLS).returning();
    const agentRows = await tx
      .insert(agents)
      .values(
        AGENTS.map(({ name, description, model, maxSteps, systemPrompt }) => ({
          name,
          slug: agentSlug(name),
          description,
          model: SEED_MODEL ?? model,
          maxSteps,
          systemPrompt,
        })),
      )
      .returning();

    const skillId = new Map(skillRows.map((row) => [row.name, row.id]));
    const toolId = new Map(toolRows.map((row) => [row.name, row.id]));
    const agentId = new Map(agentRows.map((row) => [row.name, row.id]));

    const writerId = agentId.get("Response writer");
    const [selfMcp] = await tx
      .insert(mcpServers)
      .values({
        name: "agentlathe local",
        serverUrl: `${APP_URL}/mcp/agents/${writerId}`,
      })
      .returning();

    const skillLinks = AGENTS.flatMap((agent) =>
      agent.skills.map((name) => ({
        agentId: agentId.get(agent.name) as string,
        skillId: skillId.get(name) as string,
      })),
    );
    const toolLinks = AGENTS.flatMap((agent) =>
      agent.tools.map((name) => ({
        agentId: agentId.get(agent.name) as string,
        toolId: toolId.get(name) as string,
      })),
    );
    const subAgentLinks = AGENTS.flatMap((agent) =>
      agent.subAgents.map((name) => ({
        parentId: agentId.get(agent.name) as string,
        childId: agentId.get(name) as string,
      })),
    );
    const mcpLinks = [
      {
        agentId: agentId.get("Support coordinator") as string,
        serverId: selfMcp.id,
        toolName: agentAskToolName(agentSlug("Response writer")),
      },
      ...(github
        ? (
            AGENTS.find((a) => a.name === "Repository analyst")?.github ?? []
          ).map((toolName) => ({
            agentId: agentId.get("Repository analyst") as string,
            serverId: github.id,
            toolName,
          }))
        : []),
    ];

    await tx.insert(agentSkills).values(skillLinks);
    await tx.insert(agentTools).values(toolLinks);
    await tx.insert(agentSubAgents).values(subAgentLinks);
    await tx.insert(agentMcpTools).values(mcpLinks);

    console.log(
      `seed-demo: ${skillRows.length} skills, ${toolRows.length} tools, ${agentRows.length} agents, ${subAgentLinks.length} sub-agent links, ${mcpLinks.length} MCP tools.`,
    );
    if (SEED_MODEL)
      console.log(`seed-demo: all agents seeded with model "${SEED_MODEL}".`);
    if (!github)
      console.log(
        "seed-demo: no 'GitHub' MCP server found; Repository analyst is left without MCP tools.",
      );
  });
}

if (isMain(import.meta.url)) {
  seedDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
