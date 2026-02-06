import { SpawnPlannerSchema, PLANNING_TYPES } from '../utils/sanitize.js';
import { MODEL_IDS, OPUS_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnPlannerTool = {
  name: 'spawn_planner',
  description: `📋 **SPAWN SUPER-PLANNER — Autonomous Architecture & Planning Agent**

Spawns an autonomous planning agent that creates detailed, executable plans with task breakdowns, dependency graphs, and handoff documents for the Coder and Tester.

**Model is ALWAYS ${OPUS_MODEL}** (most capable) regardless of the model parameter — planning requires maximum reasoning capability.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ **REQUIREMENTS — YOUR REQUEST WILL BE VALIDATED AND REJECTED IF NOT MET:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• **prompt**: MINIMUM **300 CHARACTERS** — a clear problem description with scope
• Describe the **PROBLEM to solve**, not the solution — the planner determines the solution
• A lazy or vague prompt WILL be rejected with guidance on how to fix it

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **BRIEF TEMPLATE — Your prompt MUST include ALL of these sections:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **PROBLEM STATEMENT:** What needs to be solved — the actual problem, not a proposed solution.
   Be specific: "Users get logged out every 15 minutes because access tokens expire without refresh"
   NOT: "Add refresh tokens"

🚫 **CONSTRAINTS:** What has been ruled out, what must be preserved, what cannot change.
   Example: "Cannot modify the database schema", "Must maintain backward compatibility with API v1"

✅ **VERIFIED FACTS:** What you already know — so the planner does NOT re-investigate.
   Example: "The tokens table already exists with columns: id, user_id, token, expires_at, revoked"

📏 **SCOPE:** What is IN scope and what is OUT of scope — be explicit about boundaries.
   IN: "Auth service token refresh flow"
   OUT: "Mobile app UI changes, notification system"

📤 **EXPECTED OUTPUT:** What the next agent (Coder or Tester) needs from this plan.
   Example: "Task breakdown with exact file paths, success criteria per task, and tester checklist"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ **BAD vs ✅ GOOD EXAMPLES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ BAD: "Plan the authentication feature"
❌ BAD: "Create a plan for refactoring"
❌ BAD: "Figure out how to add search"

✅ GOOD (300+ chars with all sections):
"🎯 PROBLEM STATEMENT: Users are getting logged out every 15 minutes because access tokens expire and there's no refresh mechanism. Mobile app v2.2 needs silent token refresh.

🚫 CONSTRAINTS: Cannot modify database schema. Must maintain backward compatibility with mobile v2.1. The existing login() and register() methods must not change.

✅ VERIFIED FACTS: The tokens table exists with columns: id, user_id, token, expires_at, revoked. JWT utility exists at /Users/dev/project/src/utils/jwt.ts.

📏 SCOPE: IN: Auth service refresh flow, token rotation. OUT: Mobile app UI, push notifications.

📤 EXPECTED OUTPUT: Task breakdown for spawn_coder with file paths, success criteria, and tester checklist."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📎 **WHAT THE PLANNER CREATES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The planner writes files to \`.agent-workspace/plans/[topic-slug]/\`:
• \`PLAN.md\` — Complete consolidated plan
• \`05-handoff/builder-briefing.md\` — ⭐ For spawn_coder (attach as context_file)
• \`05-handoff/tester-checklist.md\` — ⭐ For spawn_tester (attach as context_file)
• \`05-handoff/human-summary.md\` — ⭐ For human review

**After the planner completes**, use these files as \`context_files\` when spawning \`spawn_coder\`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 **RECOMMENDED WORKFLOW:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **spawn_planner** → creates plan ← **YOU ARE HERE**
2. **spawn_coder** → references plan's \`builder-briefing.md\` in context_files
3. **spawn_tester** → references plan's \`tester-checklist.md\` in context_files

Use \`depends_on\` to chain: spawn_coder waits for spawn_planner to complete.

**After spawning:** Check status via MCP Resources:
- \`task:///all\` → List all tasks with status
- \`task:///{id}\` → Full task details, output, metrics

Account rotation and rate limit recovery happen automatically.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `**MANDATORY — MINIMUM 300 CHARACTERS**

The problem description for the planning agent. Describe the PROBLEM, not the solution — the planner determines the best approach.

⚠️ **YOUR PROMPT WILL BE REJECTED IF:**
• It is shorter than 300 characters
• It describes a solution instead of a problem

📋 **YOUR PROMPT MUST INCLUDE ALL OF THESE SECTIONS:**

🎯 PROBLEM STATEMENT: What needs to be solved — the actual problem
🚫 CONSTRAINTS: What's been ruled out, what must be preserved
✅ VERIFIED FACTS: What you already know — don't re-investigate
📏 SCOPE: What's in/out of scope — be explicit
📤 EXPECTED OUTPUT: What the next agent needs from this plan

**Think of this as briefing a senior architect.** Give them the problem, constraints, and context — let them design the solution.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a file for the planner to analyze.' },
            description: { type: 'string', description: 'What this file contains and why the planner should read it.' },
          },
          required: ['path'],
        },
        description: `**OPTIONAL but RECOMMENDED** — Attach existing code or documentation for the planner to analyze.

📎 **WHAT TO ATTACH:**
• Existing code files the planner should understand before planning
• Research findings from spawn_researcher
• Architecture docs, API specs, requirements documents
• Previous plan files if iterating on an existing plan

File contents are read and provided to the planner as context.
Max: 20 files, 200KB each, 500KB total.`,
      },
      planning_type: {
        type: 'string',
        enum: [...PLANNING_TYPES],
        description: `Optional planning specialization. Adds domain-specific planning guidelines.

• **feature** — New feature: discovery, touchpoint mapping, data-first task ordering, risk assessment
• **bugfix** — Bug fix: root cause analysis, minimal upstream fix, mandatory regression test task
• **migration** — Migration: current/target state, incremental strategy, rollback plan, phase structure
• **refactor** — Refactoring: pattern identification, incremental changes, test preservation
• **architecture** — Architecture: system design, component boundaries, integration patterns

Each type adds specialized planning methodology. If not set, general planning guidelines apply.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model selection is IGNORED for spawn_planner — always uses ${OPUS_MODEL} (most capable) for maximum planning quality.`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute path to the working directory. The planner explores this codebase.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 1800000 (30 min). Planning may take longer for complex tasks.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete first. Example: wait for spawn_researcher to finish before planning.',
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

export const handleSpawnPlanner = createSpawnHandler({
  schema: SpawnPlannerSchema,
  toolName: 'spawn_planner',
  taskType: 'super-planner',
  validationHint: '⚠️ **REQUIRED FIELDS:**\n• `prompt`: string (min 300 characters) — describe the PROBLEM, not the solution\n\nSee the tool description for the full brief template.',
  getModel: () => OPUS_MODEL,
  getSpecialization: (parsed) => parsed.planning_type,
});
