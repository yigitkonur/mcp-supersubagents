/**
 * Provider-specific question guidance appended to sub-agent prompts at spawn time.
 *
 * Each provider's runtime exposes a different question-asking tool with different schemas:
 *   - Codex:   request_user_input  (1-3 structured questions, 2-3 options each)
 *   - Copilot: ask_user            (single question + choices array)
 *   - Claude:  AskUserQuestion     (1-4 questions, 2-4 options each, multiSelect)
 *
 * Policy: ASK when the brief is ambiguous about user-facing choices. The orchestrator
 * answers promptly. Decide yourself for implementation details and code decisions.
 */

const CODEX_GUIDANCE = `
--- QUESTION POLICY (IMPORTANT — READ BEFORE STARTING) ---

You have access to \`request_user_input\` for gathering user preferences.

**WHEN TO ASK:** The brief is ambiguous about design preferences, visual style, branding,
colors, naming, scope, content tone, or any user-facing choice where guessing wrong wastes
significant rework. Ask early — before you start building — so you build the right thing.

**WHEN TO DECIDE YOURSELF:** Implementation details, internal architecture, code patterns,
folder structure, library choices, refactoring approach, or anything the brief and codebase
already specify. For these, decide and document your assumption.

**IF YOU DECIDE WITHOUT ASKING:** Document your choice clearly in output
(e.g. "Assumed modern blue theme since brief didn't specify").

Use \`request_user_input\` with this exact schema:

\`\`\`
request_user_input({
  questions: [                          // 1-3 questions max
    {
      header: "Brand",                  // ≤12 chars, short label
      id: "brand_direction",            // snake_case, stable key
      question: "What branding direction should I use?",
      options: [                        // 2-3 options, recommended FIRST
        {
          label: "Modern Care (Recommended)",   // 1-5 words, add (Recommended) to best choice
          description: "Clean, trustworthy clinic branding."
        },
        {
          label: "Luxury Smile",
          description: "Upscale positioning with premium feel."
        }
      ]
    }
  ]
})
\`\`\`

**Rules:**
- Recommended option goes FIRST with "(Recommended)" in label
- Do NOT add an "Other" option — the client adds freeform input automatically
- Max 3 options per question. Keep labels 1-5 words. Keep descriptions one sentence.
- Ask ALL ambiguous design questions in one call (batch them), then build.
`;

const COPILOT_GUIDANCE = `
--- QUESTION POLICY (IMPORTANT — READ BEFORE STARTING) ---

You have access to \`ask_user\` for gathering user preferences.

**WHEN TO ASK:** The brief is ambiguous about design preferences, visual style, branding,
colors, naming, scope, or any user-facing choice where guessing wrong wastes significant
rework. Ask early — before you start building.

**WHEN TO DECIDE YOURSELF:** Implementation details, architecture, code patterns, or
anything the brief already specifies. Document your assumption and keep moving.

Use \`ask_user\` with this format:

\`\`\`
ask_user({
  question: "What branding direction should I use?",
  choices: [
    "Modern Care (Recommended) — clean, trustworthy clinic branding",
    "Luxury Smile — upscale positioning with premium feel"
  ],
  allowFreeform: true
})
\`\`\`

**Rules:**
- Single question only. Combine related concerns into one.
- 2-3 choices, recommended first.
- Ask before building, not mid-way through.
`;

const CLAUDE_GUIDANCE = `
--- QUESTION POLICY (IMPORTANT — READ BEFORE STARTING) ---

You have access to \`AskUserQuestion\` for gathering user preferences.

**WHEN TO ASK:** The brief is ambiguous about design preferences, visual style, branding,
colors, naming, scope, or any user-facing choice where guessing wrong wastes significant
rework. Ask early — before you start building.

**WHEN TO DECIDE YOURSELF:** Implementation details, architecture, code patterns, or
anything the brief already specifies. Document your assumption and keep moving.

Use \`AskUserQuestion\` with this exact schema:

\`\`\`
AskUserQuestion({
  questions: [                          // 1-4 questions (prefer batching related questions)
    {
      question: "What branding direction should I use?",  // required, clear question ending with ?
      header: "Brand",                  // required, ≤12 chars, short chip/tag label
      options: [                        // required, 2-4 options
        {
          label: "Modern Care (Recommended)",  // required, 1-5 words
          description: "Clean, trustworthy clinic branding."  // recommended, explains the choice
        },
        {
          label: "Luxury Smile",
          description: "Upscale positioning with premium feel."
        }
      ],
      multiSelect: false               // required, use false for mutually exclusive decisions
    }
  ]
})
\`\`\`

**Rules:**
- Do NOT add an "Other" option — the client adds freeform input automatically
- Max 4 options per question. Keep labels 1-5 words. Keep descriptions one sentence.
- Set multiSelect: false for decisions. Use true only when multiple selections make sense.
- Ask ALL ambiguous questions in one call, then build.
`;

const AUTONOMOUS_GUIDANCE = `
--- QUESTION POLICY ---
No question channel is available for this session. You MUST decide autonomously.
When the brief is ambiguous about design preferences, branding, colors, naming, or scope:
- Choose the most reasonable default
- Document your assumption clearly (e.g. "Assumed modern blue theme since brief didn't specify")
- Proceed without blocking
`;

const FALLBACK_GUIDANCE = `
--- QUESTION POLICY ---
When the brief is ambiguous about design preferences, branding, colors, naming, or scope —
ask using the question tool if available. The orchestrator answers promptly.
For implementation details — decide yourself and document your assumption.
`;

/**
 * Returns provider-specific question guidance to append to the sub-agent prompt.
 * Includes full tool schema details so the agent knows the exact format.
 *
 * If the provider does not support user input, returns autonomous guidance
 * telling the agent to decide on its own.
 */
export function getQuestionGuidance(providerId: string, supportsUserInput: boolean): string {
  if (!supportsUserInput) {
    return AUTONOMOUS_GUIDANCE;
  }

  switch (providerId) {
    case 'codex':
      return CODEX_GUIDANCE;
    case 'copilot':
      return COPILOT_GUIDANCE;
    case 'claude-cli':
      return CLAUDE_GUIDANCE;
    default:
      return FALLBACK_GUIDANCE;
  }
}
