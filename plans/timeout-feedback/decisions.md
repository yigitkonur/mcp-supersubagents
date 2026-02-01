# Key Decisions

## Decision 1: Batch Output Should Include Timeout Reasons
**Context:** Users calling batch get_status only see “timed out” without reason or next action.
**Options:** A=Add Reason column, B=Add appendix with reason + guidance, C=Auto-expand timed_out tasks.
**Chosen:** A + B (Reason column plus a concise guidance section for timed_out).
**Rationale:** Keeps the table scannable while still providing actionable guidance without flooding output.
**Tradeoffs:** Slightly more verbose batch output; requires careful wording to avoid confusion.

## Decision 2: Default Timeout Set to 30 Minutes
**Context:** 10-minute default is too aggressive for long tasks.
**Options:** A=30 min default, B=Keep 10 min, C=1 hour default.
**Chosen:** A (30 minutes).
**Rationale:** Balances longer tasks with reasonable failure visibility.
**Tradeoffs:** Longer waits before timeout on genuinely stuck tasks.

## Decision 3: Timeout Param Guidance
**Context:** Users over-set timeout without understanding consequences.
**Options:** A=Keep description minimal, B=Explicitly warn to avoid setting unless necessary.
**Chosen:** B.
**Rationale:** Reduces misuse and helps keep defaults consistent.
