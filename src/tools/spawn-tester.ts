import { SpawnTesterSchema } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { handleSharedSpawn } from './shared-spawn.js';
import type { ToolContext } from '../types.js';
import { mcpValidationError } from '../utils/format.js';

export const spawnTesterTool = {
  name: 'spawn_tester',
  description: `🧪 **SPAWN SUPER-TESTER — Autonomous QA & Testing Agent**

Spawns an autonomous testing agent that verifies implementations through E2E tests, API testing (curl), browser testing (Playwright), and existing test suites. The agent proves things work in the real world — if it says "PASS", it works in production.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ **REQUIREMENTS — YOUR REQUEST WILL BE VALIDATED AND REJECTED IF NOT MET:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• **prompt**: MINIMUM **300 CHARACTERS** — describe what was built and what to test
• **context_files**: **MANDATORY** — at least 1 file (code files, HANDOFF.md from coder, or test checklist from planner)
• A lazy or vague prompt WILL be rejected with guidance on how to fix it

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 **BRIEF TEMPLATE — Your prompt MUST include ALL of these sections:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **WHAT WAS BUILT:** The feature or fix to verify — what exactly was implemented?
   Be specific: "JWT refresh token rotation in /Users/dev/project/src/services/token-service.ts"

📁 **FILES CHANGED:** Where to focus testing — absolute paths to all modified files.
   The tester uses these to understand the scope of changes.

✅ **SUCCESS CRITERIA:** What "working" means — specific, testable conditions.
   NOT "it should work" — but "POST /auth/refresh returns 200 + new tokens when given valid refresh token"
   List EACH criterion separately so the tester can verify them independently.

🔍 **TEST SUGGESTIONS:** Specific flows to test — happy path AND error cases.
   Example: "1. Login → get tokens → wait → refresh → verify new tokens work"
   Example: "2. Try refresh with expired token → should return 401"

⚠️ **EDGE CASES:** What the coder is worried about — potential failure points.
   Example: "Race condition if two refresh requests fire simultaneously"
   Example: "Token rotation might not invalidate old token in Redis cache"

🌐 **BASE URL / SETUP:** How to access the system under test.
   Example: "Run \`npm run dev\` → http://localhost:3000"
   Example: "Docker compose already running at http://localhost:8080"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ **BAD vs ✅ GOOD EXAMPLES:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ BAD: "Test the auth feature"
❌ BAD: "Make sure it works"
❌ BAD: "Run the tests"

✅ GOOD (300+ chars with all sections):
"🎯 WHAT WAS BUILT: JWT refresh token rotation — new POST /auth/refresh endpoint that accepts a refresh token, validates it, issues new access + refresh tokens, and invalidates the old refresh token.

📁 FILES CHANGED:
- /Users/dev/project/src/services/token-service.ts (added refreshToken method)
- /Users/dev/project/src/routes/auth.ts (added POST /auth/refresh endpoint)

✅ SUCCESS CRITERIA:
1. POST /auth/refresh with valid refresh token → 200 + new access_token + new refresh_token
2. Old refresh token → 401 after rotation (replay attack prevention)
3. Expired refresh token → 401 with error message
4. Missing refresh token → 400

🔍 TEST SUGGESTIONS: Login flow → capture tokens → call refresh → verify new tokens → verify old token rejected

⚠️ EDGE CASES: Concurrent refresh requests, expired tokens, malformed tokens

🌐 SETUP: npm run dev → http://localhost:3000. Test user: test@example.com / password123"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📎 **CROSS-REFERENCE — Attach outputs from other agents:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• **Coder's handoff:** \`.agent-workspace/implementation/[topic]/HANDOFF.md\`
• **Planner's test checklist:** \`.agent-workspace/plans/[topic]/05-handoff/tester-checklist.md\`
• **Source code files** that were modified by the coder

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 **RECOMMENDED WORKFLOW:**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **spawn_planner** → creates plan with tester checklist
2. **spawn_coder** → implements the plan, creates HANDOFF.md
3. **spawn_tester** → verifies implementation ← **YOU ARE HERE**

Use \`depends_on\` to chain: spawn_tester waits for spawn_coder to complete.

**After spawning:** Check status via MCP Resources:
- \`task:///all\` → List all tasks with status
- \`task:///{id}\` → Full task details, output, metrics`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `**MANDATORY — MINIMUM 300 CHARACTERS**

The complete testing brief. Describe what was built, what to test, and how to verify success.

⚠️ **YOUR PROMPT WILL BE REJECTED IF:**
• It is shorter than 300 characters
• It does not include success criteria

📋 **YOUR PROMPT MUST INCLUDE ALL OF THESE SECTIONS:**

🎯 WHAT WAS BUILT: Feature/fix to verify
📁 FILES CHANGED: Absolute paths to modified files
✅ SUCCESS CRITERIA: Specific, testable conditions
🔍 TEST SUGGESTIONS: Flows to test (happy + error paths)
⚠️ EDGE CASES: Potential failure points
🌐 BASE URL / SETUP: How to access the system`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a file for the tester to reference.' },
            description: { type: 'string', description: 'What this file is and what to focus on when testing.' },
          },
          required: ['path'],
        },
        description: `**MANDATORY — At least 1 file REQUIRED**

Attach code files that were changed, handoff documents from the coder, or test checklists from the planner.

📎 **WHAT TO ATTACH:**
• Coder's handoff: \`.agent-workspace/implementation/[topic]/HANDOFF.md\`
• Planner's tester checklist: \`.agent-workspace/plans/[topic]/05-handoff/tester-checklist.md\`
• Modified source code files the tester should examine
• API specs or test data files

Files can be any type (not restricted to .md). Max: 20 files, 200KB each, 500KB total.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute path to the working directory where tests should run.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 1800000 (30 min). Testing may need longer for complex E2E flows.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete first. Chain: spawn_coder task → spawn_tester task.',
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

export async function handleSpawnTester(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed;
  try {
    parsed = SpawnTesterSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `❌ **SCHEMA VALIDATION FAILED — spawn_tester**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\n⚠️ **REQUIRED FIELDS:**\n• \`prompt\`: string (min 300 characters)\n• \`context_files\`: array with at least 1 file (handoff, code, or test checklist)\n\nSee the tool description for the full brief template.`
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
      toolName: 'spawn_tester',
      taskType: 'super-tester',
    },
    ctx,
  );
}
