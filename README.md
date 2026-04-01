# pi-supervisor

A [pi](https://pi.dev) extension that supervises the coding agent and steers it toward a defined outcome. It observes every conversation turn, injects guiding messages when the agent drifts, and signals when the goal is reached — like a tech lead watching over a dev's shoulder.

> A supervisor as the intelligent overseer keeping the agent on track.

> **Status:** Early release.

<img height="298" alt="image" src="https://github.com/monotykamary/pi-supervisor/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/f3b23662-6473-4ac3-82f7-c7f9b34fa7c7

## How It Works

```
/supervise                    # Auto-infer goal from conversation
# or
/supervise Refactor auth to use dependency injection
```

Then start the conversation normally — the supervisor watches from outside without modifying the agent's context.

1. **After each run** — the supervisor analyzes the conversation against the goal when the agent goes idle
2. **Mid-run, only when needed** — checks after steering (to verify it worked) or every 8th turn as safety valve
3. **On completion** — supervisor signals done and stops automatically

The supervisor is a pure outside observer. It runs in a separate in-memory pi session sharing only the API credentials and never touches the main agent's context window or system prompt.

**Token efficiency:** The supervisor reuses its session across analyses and builds conversation snapshots incrementally, using ~85% fewer tokens than naive supervision.

## Install

```bash
pi install git:github.com/monotykamary/pi-supervisor@master
```

Or load directly for development:

```bash
pi -e ~/projects/pi-supervisor/src/index.ts
```

## Commands

| Command                | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `/supervise`           | Auto-infer goal from conversation, or open settings panel |
| `/supervise <outcome>` | Start supervising with explicit goal                      |
| `/supervise stop`      | Stop active supervision                                   |
| `/supervise widget`    | Toggle the status widget on/off                           |

### Examples

```
/supervise Refactor the auth module to use dependency injection and add 90% test coverage

/supervise stop
```

The agent can also initiate supervision itself by calling the `start_supervision` tool — useful when it recognises a task needs goal tracking. Once active, supervision is locked: only the user can change or stop it.

## UI

### Settings Panel

Run `/supervise` (no args) to open the interactive settings panel:

- **Model** — shows current model; press Enter to browse all available models
- **Widget** — toggle visibility
- **Outcome** (when active) — shows goal, steer count, and turn count
- **Stop** (when active) — stop supervision directly from the panel

Navigate with arrow keys, Escape to close. Changes are applied on close.

### Live Widget

**Footer** (always visible while supervising):

```
🎯
```

**Widget** (one line, updated live):

```
◉ Supervising · Goal: "Refactor auth module…" · claude-haiku · ↗ 2 · ⟳ turn 4
  The agent has added the DI container but hasn't updated the existing call sites yet…
```

When the supervisor detects an ineffective pattern, the reframe tier appears (e.g., `↻2`):

```
◉ Supervising · Goal: "Implement payment flow…" · claude-haiku · ↗ 5 · ↻2 · ⟳ turn 12
  Breaking into smaller milestone: get the checkout form rendering first…
```

The second line shows the supervisor's reasoning as it streams. Toggle the widget with `/supervise widget`.

## How Supervision Works

**Analysis triggers:**

| When                          | Why                                              |
| ----------------------------- | ------------------------------------------------ |
| Agent goes idle (`agent_end`) | Critical decision point — must choose done/steer |
| After we steered              | Verify the steer worked                          |
| Every 8th turn                | Safety valve to catch runaway drift              |
| Tool errors detected          | If agent hits an error, we check                 |

The supervisor only intervenes when it has high confidence the agent is off track. It trusts the agent to make progress and only steps in when necessary.

## Reframe Escalation

When the supervisor detects that steering isn't working, it escalates through **4 tiers** of reframing strategies rather than giving up:

| Tier | Trigger                   | Strategy                                                                   |
| ---- | ------------------------- | -------------------------------------------------------------------------- |
| 0    | (default)                 | Standard steering                                                          |
| 1    | Similar messages detected | **Directive** — be extremely specific about the next single action         |
| 2    | Pattern continues         | **Subgoal** — break the goal into a smaller, verifiable milestone          |
| 3    | Still stuck               | **Pivot** — suggest a completely different strategy or implementation path |
| 4    | Persistent stall          | **Minimal slice** — strip to absolute essentials, demand tangible output   |

**Pattern detection:** The supervisor tracks two indicators of ineffectiveness:

- **Message similarity** — when 2+ recent steering messages are similar (suggesting the agent isn't responding)
- **Stagnation** — when 3+ turns pass without progress after a steer

When either pattern is detected, the supervisor escalates the reframe tier and injects tier-specific guidance into its prompt. The tier resets when the goal is achieved. This allows the supervisor to adapt to long-horizon projects that may take hours or days, rather than forcing early termination.

## Supervisor Model

The supervisor runs on a **separate model** — it can be a cheaper/faster model than the one doing the actual work.

**Resolution order:**

1. Previous session state (persists within a session)
2. `.pi/supervisor-config.json` in the project root (saved via settings panel)
3. Active chat model (`ctx.model`) — so it works out of the box with no configuration
4. Built-in default: `anthropic/claude-haiku-4-5-20251001`

Change at any time through the settings panel (run `/supervise` and select **Model**). The selection is saved to `.pi/supervisor-config.json` if the `.pi/` directory exists.

## Focus and Goal Discipline

The supervisor is a pure outside observer — it does not modify the agent's system prompt. Goal discipline is enforced entirely through steering messages when the agent drifts. If the agent asks an out-of-scope clarifying question, the supervisor redirects it back to the goal rather than answering.

Unlike earlier versions, there are **no artificial limits** on steering attempts. The supervisor uses [reframe escalation](#reframe-escalation) to adapt its strategy when standard steering isn't working, allowing it to supervise long-horizon projects that may take hours or days to complete.

## Customizing the Supervisor: SUPERVISOR.md

The supervisor's reasoning is controlled by its **system prompt** — not the goal. The goal is always set at runtime via `/supervise`. `SUPERVISOR.md` defines _how_ the supervisor thinks: its rules, persona, and project-specific constraints.

**Discovery order** (mirrors pi's `SYSTEM.md` convention):

| Priority | Location                    | Use for                |
| -------- | --------------------------- | ---------------------- |
| 1        | `.pi/SUPERVISOR.md`         | Project-specific rules |
| 2        | `~/.pi/agent/SUPERVISOR.md` | Global personal rules  |
| 3        | Built-in template           | Fallback               |

The active source is shown when you run `/supervise` or `/supervise status`.

### Built-in system prompt

The default prompt the supervisor uses when no `SUPERVISOR.md` is found:

```
You are a supervisor monitoring a coding AI assistant conversation.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → only when the outcome is completely and verifiably achieved.
- "steer" → everything else: incomplete work, partial progress, open questions, waiting for confirmation.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it what to do next.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer and remind it not to take shortcuts.

"done" CRITERIA: The core outcome is complete and functional. Minor polish, style tweaks, or
optional improvements do NOT block "done". Prefer stopping when the goal is substantially
achieved rather than looping forever chasing perfection.

Respond ONLY with valid JSON — no prose, no markdown fences.
Response schema (strict JSON):
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85    // Float 0-1
}
```

**Dynamic reframe guidance:** When the supervisor detects an ineffective pattern, it injects tier-specific guidance into the prompt (see [Reframe Escalation](#reframe-escalation)).

### Writing a custom SUPERVISOR.md

You must preserve the JSON response schema. Everything else is up to you.

```markdown
You are a supervisor for a TypeScript project. Your priorities: type safety and test coverage.

Rules:

- Steer if the agent uses `any` types or skips tests for new code
- When steering, be direct: one sentence max, reference the specific file/function if possible
- "done" only when the new code has types and tests — not before
- Do not steer about code style, naming, or documentation

Response schema (strict JSON, required):
{
"action": "continue" | "steer" | "done",
"message": "...",
"reasoning": "...",
"confidence": 0.85
}
```

## Session Persistence

Supervision state (outcome, model, intervention history) is stored in the pi session file and restored automatically on restart, session switch, fork, and tree navigation.

## Testing

Run the test suite:

```bash
npm test           # Run once
npm run test:watch # Watch mode
```

Coverage report generated in `coverage/`.

## Project Structure

```
src/
  index.ts              # Extension entry point, event wiring, /supervise command, start_supervision tool
  types.ts              # SupervisorState, SteeringDecision, ConversationMessage, ReframeTier
  state.ts              # SupervisorStateManager — in-memory state + session persistence, reframe tier management, pattern detection
  engine.ts             # Snapshot building, SUPERVISOR.md loading, prompt construction, analyze(), reframe guidance
  model-client.ts       # SupervisorSession (reusable), one-shot calls via pi's AgentSession API
  global-config.ts      # .pi/supervisor-config.json read/write for model persistence
  ui/
    status-widget.ts    # 🎯 footer badge + one-line widget with live thinking stream + reframe tier indicator
    model-picker.ts     # Interactive model picker using pi's ModelSelectorComponent
    settings-panel.ts   # Interactive settings overlay using pi-tui's SettingsList
```

## License

MIT — [tintinweb](https://github.com/tintinweb) (forked by [monotykamary](https://github.com/monotykamary))
