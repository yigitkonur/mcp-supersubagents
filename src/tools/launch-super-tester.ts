import { z } from 'zod';
import { AGENT_MODES } from '../types.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesRequired, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION } from './spawn-schemas.js';

// --- Zod schema (tester-specific: context_files REQUIRED, any file type) ---

const LaunchSuperTesterSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesRequired,
  mode: z.enum(AGENT_MODES as readonly [string, ...string[]]).default('fleet').optional(),
});

// --- Tool definition ---

export const launchSuperTesterTool = {
  name: 'launch-super-tester',
  description: `Launch an autonomous testing agent that writes and runs tests, verifies implementations, and validates edge cases. The agent runs in COMPLETE ISOLATION.

**When to call:** A coder has finished implementation and you need to verify it works. Pass the source files or handoff documents as context_files.

**context_files are MANDATORY** — the call WILL FAIL without them. Any file type accepted (source code, test files, handoff docs).

**Brief template — your prompt MUST include:**
\`\`\`
WHAT WAS BUILT: Feature/fix to verify — specific deliverable
FILES CHANGED: Where to focus testing — absolute paths
SUCCESS CRITERIA: What "working" means — specific, testable conditions
TEST SUGGESTIONS: Specific flows to test — happy path + edge cases
EDGE CASES: Potential failure points the coder is worried about
BASE URL / SETUP: How to access the system under test
\`\`\`

**Workflow position:** researcher → planner → coder → **TESTER**
Chain with \`depends_on\` after the coder task. Pass changed source files and handoff docs as \`context_files\`.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your testing brief. MUST include: WHAT WAS BUILT (feature to verify), FILES CHANGED (absolute paths), SUCCESS CRITERIA (testable conditions), TEST SUGGESTIONS (flows to test), EDGE CASES (failure points). Min 300 chars.',
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path (must start with /).' },
            description: { type: 'string', description: 'What this file contains and why the agent needs it.' },
          },
          required: ['path'],
        },
        description: 'REQUIRED. Source files, test files, or handoff docs the tester needs. Any file type accepted. Max 20 files, 200KB each, 500KB total.',
      },
      ...baseInputSchemaProperties,
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after coder.',
      },
      mode: {
        type: 'string',
        enum: ['fleet', 'plan', 'autopilot'],
        description: 'Execution mode. fleet=parallel sub-agents (default), plan=plan-then-execute, autopilot=direct autonomous execution.',
        default: 'fleet',
      },
    },
    required: ['prompt', 'context_files'],
  },
  annotations: buildAnnotations('Launch Super Tester'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchSuperTester = createLaunchHandler(
  LaunchSuperTesterSchema,
  'launch-super-tester',
  { toolName: 'tester', taskType: 'super-tester' },
);
