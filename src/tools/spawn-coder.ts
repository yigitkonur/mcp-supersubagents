import { SpawnCoderSchema, CODER_LANGUAGES } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnCoderTool = {
  name: 'spawn_coder',
  description: `🔧 **SPAWN SUPER-CODER — Autonomous Implementation Agent**

Spawns an autonomous coding agent that implements code changes. The agent runs **completely isolated** with NO shared memory — your brief and attached context files are its ONLY context. It cannot see your conversation history, previous tool calls, or any other context.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ **REQUIREMENTS — YOUR REQUEST WILL BE VALIDATED AND REJECTED IF NOT MET:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• **prompt**: MINIMUM **1,000 CHARACTERS** — a comprehensive implementation brief
• **context_files**: **MANDATORY** — at least 1 Markdown file (.md) with detailed plan or specification
• All context files MUST: end with \`.md\`, use absolute paths, exist on disk, be readable
• A lazy or vague prompt WILL be rejected with guidance on how to fix it

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **BRIEF TEMPLATE — Your prompt MUST include ALL of these sections:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **OBJECTIVE:** What exactly to build or modify — specific deliverables, not vague goals.
   State precisely what the agent should create, change, or fix. Name the exact functions,
   components, or modules involved.

📁 **FILES TO MODIFY:** ALL absolute file paths the agent needs to read or edit.
   Example: /Users/dev/project/src/services/auth.ts, /Users/dev/project/src/types.ts
   The agent has NO knowledge of your project — every file path must be explicit.

✅ **SUCCESS CRITERIA:** Exactly how to verify the implementation is correct.
   Not "it should work" — but "POST /api/login returns 200 with valid JWT when credentials match"
   or "npm test -- --grep auth passes all 5 tests".

🚫 **CONSTRAINTS:** What NOT to do — boundaries, forbidden approaches, patterns to avoid.
   Example: "Do NOT modify the database schema", "Do NOT use any external packages",
   "Keep backward compatibility with v1 API consumers".

🔗 **PATTERNS TO FOLLOW:** Existing code patterns the agent should match.
   Reference specific files: "Follow the pattern in /Users/dev/project/src/services/user.ts"
   Reference utilities: "Use the existing validateEmail() from /Users/dev/project/src/utils/validation.ts"

📝 **CONTEXT:** Background — why this matters, architectural decisions, dependencies.
   What does the agent need to understand about the bigger picture?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ **BAD vs ✅ GOOD EXAMPLES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ BAD: "Fix the login bug"
❌ BAD: "Implement the feature from the plan"
❌ BAD: "Add authentication to the API"

✅ GOOD (1000+ chars with all sections):
"🎯 OBJECTIVE: Implement JWT refresh token rotation in the auth service. Create a new refreshToken() method in the token service that issues a new access token + rotated refresh token, invalidating the old refresh token.

📁 FILES TO MODIFY:
- /Users/dev/project/src/services/token-service.ts — add refreshToken() method
- /Users/dev/project/src/routes/auth.ts — add POST /auth/refresh endpoint
- /Users/dev/project/src/types/auth.ts — add RefreshTokenPayload interface

✅ SUCCESS CRITERIA:
- POST /auth/refresh with valid refresh token returns new access + refresh tokens
- Old refresh token becomes invalid after rotation (replay attack prevention)
- Expired refresh tokens return 401 with clear error message

🚫 CONSTRAINTS:
- Do NOT modify the existing login() or register() methods
- Do NOT change the database schema — use the existing tokens table
- Keep backward compatibility with mobile app v2.1

🔗 PATTERNS TO FOLLOW:
- Follow the pattern in /Users/dev/project/src/services/token-service.ts login() method
- Use the existing jwt utility at /Users/dev/project/src/utils/jwt.ts

📝 CONTEXT: Mobile app v2.2 needs silent token refresh. Currently users get logged out every 15 minutes when the access token expires. The refresh token table already exists in the database."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📎 **CROSS-REFERENCE — Attach outputs from other agents:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• If you ran **spawn_planner** → attach its output:
  \`.agent-workspace/plans/[topic]/05-handoff/builder-briefing.md\`
  \`.agent-workspace/plans/[topic]/PLAN.md\`

• If you ran **spawn_researcher** → attach its output:
  \`.agent-workspace/researches/[topic]/HANDOFF.md\`
  \`.agent-workspace/researches/[topic]/05-conclusion/action-items.md\`

• If you wrote your own brief → save it as a .md file and attach it

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 **RECOMMENDED WORKFLOW:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **spawn_planner** → creates detailed plan with task breakdown
2. **spawn_coder** → references plan files in context_files ← **YOU ARE HERE**
3. **spawn_tester** → verifies the implementation against success criteria

**After spawning:** Check status via MCP Resources:
- \`task:///all\` → List all tasks with status
- \`task:///{id}\` → Full task details, output, metrics

Account rotation and rate limit recovery happen automatically.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `**MANDATORY — MINIMUM 1,000 CHARACTERS**

The complete implementation brief for the coding agent. This is the ONLY context the agent will have — it cannot see your conversation, previous tool calls, or any other context.

⚠️ **YOUR PROMPT WILL BE REJECTED IF:**
• It is shorter than 1,000 characters
• It does not include specific file paths
• It is vague or lacks actionable detail

📋 **YOUR PROMPT MUST INCLUDE ALL OF THESE SECTIONS:**

🎯 OBJECTIVE: What exactly to build/modify — specific deliverables
📁 FILES TO MODIFY: ALL absolute file paths the agent needs
✅ SUCCESS CRITERIA: How to verify the implementation is correct
🚫 CONSTRAINTS: What NOT to do — boundaries, forbidden approaches
🔗 PATTERNS TO FOLLOW: Existing code patterns to match
📝 CONTEXT: Background, dependencies, architectural decisions

**Think of this as a complete brief for a developer who has never seen the codebase and cannot ask you questions.** Every piece of information they need must be in this prompt or in the attached context_files.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to a Markdown (.md) file. MUST start with / and end with .md',
            },
            description: {
              type: 'string',
              description: 'What this file contains and why it is relevant to the implementation task.',
            },
          },
          required: ['path'],
        },
        description: `**MANDATORY — At least 1 Markdown file (.md) REQUIRED**

Context files provide the agent with detailed plans, specifications, or research findings. Their contents are read and injected into the agent's prompt.

⚠️ **REQUIREMENTS (VALIDATED — WILL REJECT IF NOT MET):**
• At least **1 file** REQUIRED — the agent needs a written plan or specification
• Files MUST end with **\`.md\`** extension — only Markdown files accepted
• Paths MUST be **absolute** (start with \`/\`)
• Files MUST **exist** on disk and be **readable**
• Max file size: 200KB per file, 500KB total

📎 **WHAT TO ATTACH:**
• Plan from spawn_planner: \`.agent-workspace/plans/[topic]/05-handoff/builder-briefing.md\`
• Research from spawn_researcher: \`.agent-workspace/researches/[topic]/HANDOFF.md\`
• Your own specification: any \`.md\` file you created with implementation details
• Architecture docs: any \`.md\` file describing the system architecture

❌ BAD: \`context_files: []\` (empty — will be rejected)
❌ BAD: \`context_files: [{path: "plan.md"}]\` (relative path — must be absolute)
❌ BAD: \`context_files: [{path: "/path/to/code.ts"}]\` (not .md — must be Markdown)

✅ GOOD:
\`\`\`json
context_files: [{
  path: "/Users/dev/project/.agent-workspace/plans/auth/05-handoff/builder-briefing.md",
  description: "Implementation plan for JWT refresh token rotation. Contains task breakdown, file paths, success criteria, and patterns to follow. Created by spawn_planner."
}]
\`\`\``,
      },
      language: {
        type: 'string',
        enum: [...CODER_LANGUAGES],
        description: `Optional language specialization. Adds language-specific coding guidelines to the agent's instructions.

• **typescript** — Strict typing, interfaces over types, no \`any\`, discriminated unions, named exports
• **python** — PEP 8, type hints, docstrings, dataclasses/Pydantic, pathlib, generators
• **rust** — Ownership patterns, error handling with Result/Option, lifetime annotations
• **go** — Go idioms, error handling patterns, goroutine safety
• **java** — Design patterns, proper exception hierarchy, immutability
• **ruby** — Ruby idioms, blocks/procs, proper gem usage
• **swift** — Protocol-oriented programming, optionals, value types
• **csharp** — LINQ, async/await patterns, nullable reference types
• **kotlin** — Coroutines, sealed classes, null safety
• **general** — No language-specific overlay (agent infers from codebase)

If not set, the agent uses general coding guidelines and infers language from the codebase.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.
- claude-sonnet-4.5: Best balance of speed and capability (default, recommended)
- claude-haiku-4.5: Fastest — use for simple, well-defined single-file changes`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute path to the working directory. Pass your current working directory as a full absolute path.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 1800000 (30 min). Only override for known long/short tasks.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true. Almost always leave this as true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use this to chain: spawn_planner task → spawn_coder task.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping and filtering tasks (max 10).',
      },
    },
    required: ['prompt', 'context_files'],
  },
};

export const handleSpawnCoder = createSpawnHandler({
  schema: SpawnCoderSchema,
  toolName: 'spawn_coder',
  taskType: 'super-coder',
  validationHint: '⚠️ **REQUIRED FIELDS:**\n• `prompt`: string (min 1,000 characters)\n• `context_files`: array with at least 1 Markdown file (.md)\n\nBoth fields are MANDATORY. See the tool description for the full brief template.',
  getSpecialization: (parsed) => parsed.language,
});
