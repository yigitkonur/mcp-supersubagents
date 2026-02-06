import { SpawnResearcherSchema } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { handleSharedSpawn } from './shared-spawn.js';
import type { ToolContext } from '../types.js';
import { mcpValidationError } from '../utils/format.js';

export const spawnResearcherTool = {
  name: 'spawn_researcher',
  description: `🔍 **SPAWN SUPER-RESEARCHER — Autonomous Investigation Agent**

Spawns an autonomous research agent that investigates technical questions, evaluates options, and produces evidence-based recommendations. The agent searches the web, scrapes documentation, analyzes Reddit discussions, and explores your codebase to find answers backed by authoritative sources.

The researcher never says "I think" — it says "the evidence shows." Every finding traces to a source.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ **REQUIREMENTS — YOUR REQUEST WILL BE VALIDATED AND REJECTED IF NOT MET:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• **prompt**: MINIMUM **200 CHARACTERS** — with SPECIFIC questions to answer
• Do NOT send vague "research X" prompts — include specific, answerable questions
• A lazy or vague prompt WILL be rejected with guidance on how to fix it

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **BRIEF TEMPLATE — Your prompt MUST include ALL of these sections:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **WHAT TO RESEARCH:** The specific topic or question — not a vague "research X" but a precise question.
   Example: "What are the security implications of using localStorage vs httpOnly cookies for JWT storage?"
   NOT: "Research JWT storage"

🤔 **WHY IT MATTERS:** What decision does this research inform? What are you trying to decide?
   Example: "We need to choose a token storage strategy for our SPA before implementing auth"

📚 **WHAT'S ALREADY KNOWN:** Share what you already know so the researcher fills gaps, not repeats basics.
   Example: "We know localStorage is vulnerable to XSS but convenient for SPAs. httpOnly cookies prevent JS access but require CSRF protection."

❓ **SPECIFIC QUESTIONS (2-5):** Break down into specific, pointed, answerable questions.
   1. "What do OWASP and NIST recommend for SPA token storage in 2024+?"
   2. "What are the real-world attack vectors for each approach?"
   3. "How do major companies (Auth0, Okta, Firebase) handle this?"
   4. "What's the community consensus on Reddit/HN for production SPAs?"

📤 **HANDOFF TARGET:** Who reads the research output — Planner? Coder? Human?
   This determines the level of detail and format of recommendations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ **BAD vs ✅ GOOD EXAMPLES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ BAD: "Research authentication"
❌ BAD: "What's the best database?"
❌ BAD: "Look into caching"

✅ GOOD (200+ chars with all sections):
"🎯 WHAT TO RESEARCH: Security implications of JWT token storage strategies for single-page applications — localStorage vs httpOnly cookies vs in-memory.

🤔 WHY: We're implementing auth for a React SPA and need to choose a token storage strategy before sprint 23.

📚 KNOWN: localStorage is XSS-vulnerable. httpOnly cookies need CSRF protection. In-memory doesn't survive page refresh.

❓ SPECIFIC QUESTIONS:
1. What do OWASP and NIST recommend for SPA token storage in 2024+?
2. Real-world attack vectors: which approach has been exploited more?
3. How do Auth0, Okta, Firebase handle this in their SDKs?
4. Community consensus on r/webdev, r/netsec for production SPAs?

📤 HANDOFF: Planner — research feeds into spawn_planner for auth feature planning."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📎 **WHAT THE RESEARCHER CREATES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The researcher writes files to \`.agent-workspace/researches/[topic-slug]/\`:
• \`HANDOFF.md\` — ⭐ Compact findings + action items (attach to spawn_planner or spawn_coder)
• \`_META.md\` — 30-second summary with verdict and confidence level
• \`05-conclusion/recommendation.md\` — Full recommendation with evidence
• \`05-conclusion/action-items.md\` — Concrete next steps for the Builder

**After the researcher completes**, use \`HANDOFF.md\` as a \`context_file\` when spawning \`spawn_planner\` or \`spawn_coder\`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 **RECOMMENDED WORKFLOW:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **spawn_researcher** → investigates options, produces evidence-based recommendation ← **YOU ARE HERE**
2. **spawn_planner** → uses research findings to create implementation plan
3. **spawn_coder** → implements based on plan
4. **spawn_tester** → verifies implementation

Use \`depends_on\` to chain: spawn_planner waits for spawn_researcher to complete.

**After spawning:** Check status via MCP Resources:
- \`task:///all\` → List all tasks with status
- \`task:///{id}\` → Full task details, output, metrics`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `**MANDATORY — MINIMUM 200 CHARACTERS**

The research question with specific sub-questions. The researcher investigates across web, Reddit, documentation, and codebase.

⚠️ **YOUR PROMPT WILL BE REJECTED IF:**
• It is shorter than 200 characters
• It lacks specific, answerable questions

📋 **YOUR PROMPT MUST INCLUDE ALL OF THESE SECTIONS:**

🎯 WHAT TO RESEARCH: Specific topic or question
🤔 WHY IT MATTERS: What decision this informs
📚 WHAT'S ALREADY KNOWN: Don't re-research this
❓ SPECIFIC QUESTIONS: 2-5 pointed, answerable questions
📤 HANDOFF TARGET: Who reads the output (Planner/Coder/Human)

**Think of this as briefing a Staff Engineer.** Give them the context and specific questions — they'll find evidence-backed answers.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a file for the researcher to analyze.' },
            description: { type: 'string', description: 'What this file is and what to focus on during research.' },
          },
          required: ['path'],
        },
        description: `**OPTIONAL** — Attach code files or documents the researcher should analyze.

📎 **WHEN TO ATTACH:**
• Code that needs security review or architecture analysis
• Existing configuration files the researcher should understand
• Documentation or specs that provide context for the research question

Max: 20 files, 200KB each, 500KB total.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute path to the working directory. The researcher may explore this codebase.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 1800000 (30 min).',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete first.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping and filtering tasks (max 10).',
      },
    },
    required: ['prompt'],
  },
};

export async function handleSpawnResearcher(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed;
  try {
    parsed = SpawnResearcherSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `❌ **SCHEMA VALIDATION FAILED — spawn_researcher**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\n⚠️ **REQUIRED FIELDS:**\n• \`prompt\`: string (min 200 characters) — include specific questions to answer\n\nSee the tool description for the full brief template.`
    );
  }

  return handleSharedSpawn(
    {
      prompt: parsed.prompt,
      context_files: parsed.context_files,
      model: parsed.model,
      cwd: parsed.cwd,
      timeout: parsed.timeout,
      autonomous: parsed.autonomous,
      depends_on: parsed.depends_on,
      labels: parsed.labels,
    },
    {
      toolName: 'spawn_researcher',
      taskType: 'super-researcher',
    },
    ctx,
  );
}
