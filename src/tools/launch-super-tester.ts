import { z } from 'zod';
import { createLaunchHandler } from './shared-spawn.js';
import { DEFAULT_MODEL } from '../models.js';
import { baseSpawnFields, contextFilesRequired, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty, buildModelProperty } from './spawn-schemas.js';

// --- Zod schema (tester-specific: context_files REQUIRED, any file type) ---

const LaunchSuperTesterSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesRequired,
});

// --- Tool definition ---

export const launchSuperTesterTool = {
  name: 'launch-super-tester',
  description: `Launch an autonomous testing agent. Primarily E2E testing with Playwright (browser flows, visual, interactions) but also handles API testing (curl + jq), running existing test suites, and any verification that proves the code works in the real world. Runs in COMPLETE ISOLATION.

**context_files are MANDATORY** — any file type accepted (source, tests, handoff docs). Pass ALL files from the coder's agent workspace — especially HANDOFF.md which contains testing instructions, curl examples, and Playwright hints.

**Workflow:** researcher → planner → coder → **TESTER**
Chain with depends_on after coder.

**Status:** Read \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(300, 'Testing brief. MUST include: WHAT WAS BUILT (feature to verify), FILES CHANGED (absolute paths), SUCCESS CRITERIA (testable conditions), TEST SUGGESTIONS (flows to test — include Playwright steps for UI or curl commands for APIs), EDGE CASES (failure points). Min 300 chars.'),
      context_files: buildContextFilesProperty('REQUIRED. Pass ALL files from coder\'s .agent-workspace/ — HANDOFF.md, changed source files, any test files. Don\'t filter. Any file type accepted. Max 20 files, 200KB each, 500KB total.', { required: true }),
      ...baseInputSchemaProperties,
      model: buildModelProperty(`Model to use. Default: ${DEFAULT_MODEL}. Also accepts aliases: sonnet, opus, gpt-5.4, o4-mini, etc.`),
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
