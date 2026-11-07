import { eq, inArray, or } from "drizzle-orm";
import { isMain } from "./cli-entry";
import { db } from "./client";
import {
  DEFAULT_MEMORY_PURPOSES,
  type MemoryScope,
  memoryPartitionKey,
  type ScheduleFrequency,
} from "./constants";
import { applyMemoryOps } from "./memory";
import { agentAskToolName, agentSlug } from "./naming";
import {
  agentCriteria,
  agentKnowledge,
  agentMcpTools,
  agentSkills,
  agentSubAgents,
  agents,
  agentTools,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeFiles,
  mcpServers,
  memoryStores,
  schedules,
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

const CRITERIA = [
  {
    agent: "Support coordinator",
    question:
      "Did the assistant avoid promising a deadline or outcome it does not control?",
    passDescription:
      "No date, time or guaranteed outcome is promised, or it is backed by a tool result.",
    failDescription:
      "The assistant promises when or how the issue will be fixed without anything confirming it.",
    appliesWhen: null,
  },
  {
    agent: "Support coordinator",
    question: "Did the assistant open a ticket for the reported problem?",
    passDescription: "A ticket was created with a tool during the run.",
    failDescription:
      "The user reported a problem and the run ended without creating a ticket.",
    appliesWhen: "Did the user report a problem with the product or service?",
  },
  {
    agent: "Data assistant",
    question:
      "Is every number in the answer taken from a tool result or stated as an assumption?",
    passDescription:
      "Each figure comes from a tool result in the transcript or is explicitly labelled as an assumption.",
    failDescription:
      "The answer contains figures that appear in no tool result and are not presented as assumptions.",
    appliesWhen: null,
  },
];

const MEMORY_NAME: Record<MemoryScope, string> = {
  agent: "Agent memory",
  agent_subject: "Agent memory per subject",
  custom: "Agent memory with a custom key",
};

const MEMORIES: Array<{
  agent: string;
  scope: MemoryScope;
  purpose?: string;
  memoryKey?: string;
  requireApproval?: boolean;
  entries: Record<string, string[]>;
}> = [
  {
    agent: "Support coordinator",
    scope: "agent_subject",
    entries: {
      "customer-123": [
        "Prefers answers in Spanish.",
        "Reported a double charge on 2026-10-14 (ticket 4512); was promised a follow-up by 2026-10-20.",
      ],
      "customer-456": [
        "On the Enterprise plan, with a dedicated account manager.",
      ],
    },
  },
  {
    agent: "Repository analyst",
    scope: "agent",
    requireApproval: true,
    entries: {},
  },
  {
    agent: "Data assistant",
    scope: "custom",
    memoryKey: "payments",
    purpose:
      "Conventions for answering about payments: how amounts are reported, which rates apply, who owns which numbers. Nothing about individual customers.",
    entries: {
      payments: [
        "Quarterly figures are reported in USD.",
        "Currency conversions use the rate published at 00:00 UTC on the day of the transaction.",
      ],
    },
  },
];

const SCHEDULES: Array<{
  agent: string;
  name: string;
  frequency: ScheduleFrequency;
  timeOfDay: string;
  weekday?: number;
  input: string;
  subjectId?: string;
  memoryKey?: string;
}> = [
  {
    agent: "Data assistant",
    name: "Weekly metrics digest",
    frequency: "weekly",
    weekday: 1,
    timeOfDay: "09:00",
    input:
      "Today is {{date}}. Summarize the key business metrics of the last 7 days and what changed since the last digest ({{last_success_at}}).",
    memoryKey: "payments",
  },
  {
    agent: "Support coordinator",
    name: "Follow-up with customer-123",
    frequency: "weekdays",
    timeOfDay: "10:00",
    input:
      "Today is {{date}}. Check what is pending with this customer and say what the next step is.",
    subjectId: "customer-123",
  },
];

async function seedDemoExamples() {
  const names = [
    ...new Set([
      ...MEMORIES.map((memory) => memory.agent),
      ...SCHEDULES.map((schedule) => schedule.agent),
    ]),
  ];
  const rows = await db
    .select({ id: agents.id, name: agents.name, model: agents.model })
    .from(agents)
    .where(inArray(agents.name, names));
  const agentOf = new Map(rows.map((row) => [row.name, row]));
  if (agentOf.size < names.length) {
    console.log(
      "seed-demo: some demo agents are missing; skipped the memory and schedule examples.",
    );
    return;
  }
  const [seeded] = await db
    .select({ id: memoryStores.id })
    .from(memoryStores)
    .where(
      inArray(
        memoryStores.ownerAgentId,
        rows.map((row) => row.id),
      ),
    )
    .limit(1);
  if (seeded) {
    console.log("seed-demo: the demo agents already have memory.");
    return;
  }

  const created = await db.transaction(async (tx) => {
    const stores = await tx
      .insert(memoryStores)
      .values(
        MEMORIES.map((memory) => {
          const agent = agentOf.get(memory.agent);
          return {
            name: MEMORY_NAME[memory.scope],
            scope: memory.scope,
            ownerAgentId: agent?.id as string,
            memoryKey: memory.memoryKey ?? null,
            purpose:
              memory.purpose ??
              DEFAULT_MEMORY_PURPOSES[memory.scope as "agent"],
            requireApproval: memory.requireApproval ?? false,
          };
        }),
      )
      .returning();
    await tx.insert(schedules).values(
      SCHEDULES.map(
        ({ agent, weekday, subjectId, memoryKey, ...schedule }) => ({
          ...schedule,
          agentId: agentOf.get(agent)?.id as string,
          weekday: weekday ?? null,
          subjectId: subjectId ?? null,
          memoryKey: memoryKey ?? null,
          timezone: "UTC",
          isActive: false,
        }),
      ),
    );
    return stores;
  });

  let entries = 0;
  for (const store of created) {
    const memory = MEMORIES.find(
      (candidate) =>
        candidate.scope === store.scope &&
        agentOf.get(candidate.agent)?.id === store.ownerAgentId,
    );
    for (const [key, contents] of Object.entries(memory?.entries ?? {})) {
      const partitionKey = memoryPartitionKey(store.scope as MemoryScope, {
        agentId: store.ownerAgentId,
        subjectId: key,
        memoryKey: key,
      });
      if (!partitionKey) continue;
      entries += contents.length;
      await applyMemoryOps(
        store.id,
        partitionKey,
        contents.map((content) => ({ op: "add" as const, content })),
        { author: "human" },
      );
    }
  }

  console.log(
    `seed-demo: ${created.length} memories with ${entries} entries, and ${SCHEDULES.length} schedules, paused: activate them in Schedules (each run calls the model).`,
  );
}

const KNOWLEDGE_COLLECTION = "Support policies";
const KNOWLEDGE_AGENT = "Support coordinator";
const KNOWLEDGE_DOCUMENT = `# Support policies

## Refunds

- Refunds up to $500 are approved by the support team on the same day.
- Refunds over $500 go to the billing team, which answers within two business days.
- An order can be refunded up to 30 days after delivery. After that, offer store credit.

## Shipping

- Orders placed before 2 p.m. ship the same business day.
- Express shipping is refunded when the order arrives late.

## Escalation

- A customer who reports the same problem three times gets a ticket with priority high.
- Never promise a delivery date the carrier has not confirmed.
`;

async function seedDemoKnowledge() {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, KNOWLEDGE_AGENT));
  const [existing] = await db
    .select({ id: knowledgeCollections.id })
    .from(knowledgeCollections)
    .where(eq(knowledgeCollections.name, KNOWLEDGE_COLLECTION));
  if (!agent || existing) return;

  const bytes = Buffer.from(KNOWLEDGE_DOCUMENT);
  await db.transaction(async (tx) => {
    const [collection] = await tx
      .insert(knowledgeCollections)
      .values({
        name: KNOWLEDGE_COLLECTION,
        description:
          "How support handles refunds, shipping and escalations: limits, deadlines and who decides.",
      })
      .returning({ id: knowledgeCollections.id });
    const [document] = await tx
      .insert(knowledgeDocuments)
      .values({
        collectionId: collection.id,
        filename: "support-policies.md",
        mediaType: "text/markdown",
        size: bytes.length,
      })
      .returning({ id: knowledgeDocuments.id });
    await tx.insert(knowledgeFiles).values({ documentId: document.id, bytes });
    await tx
      .insert(agentKnowledge)
      .values({ agentId: agent.id, collectionId: collection.id });
  });
  console.log(
    `seed-demo: the "${KNOWLEDGE_COLLECTION}" collection, attached to ${KNOWLEDGE_AGENT}; its document is indexed once the app runs (it calls the embedding model).`,
  );
}

export async function seedDemo() {
  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, MARKER))
    .limit(1);
  if (existing) {
    console.log(
      `seed-demo: "${MARKER}" already exists; adding only what is missing.`,
    );
    await seedDemoExamples();
    await seedDemoKnowledge();
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
    const criteriaRows = await tx
      .insert(agentCriteria)
      .values(
        CRITERIA.map(({ agent, ...criterion }) => ({
          agentId: agentId.get(agent) as string,
          ...criterion,
        })),
      )
      .returning({ id: agentCriteria.id });

    console.log(
      `seed-demo: ${skillRows.length} skills, ${toolRows.length} tools, ${agentRows.length} agents, ${subAgentLinks.length} sub-agent links, ${mcpLinks.length} MCP tools, ${criteriaRows.length} criteria.`,
    );
    if (SEED_MODEL)
      console.log(`seed-demo: all agents seeded with model "${SEED_MODEL}".`);
    if (!github)
      console.log(
        "seed-demo: no 'GitHub' MCP server found; Repository analyst is left without MCP tools.",
      );
  });
  await seedDemoExamples();
  await seedDemoKnowledge();
}

if (isMain(import.meta.url)) {
  seedDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
