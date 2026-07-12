<div align="center">

# 🧠 pi-supervisor

**Intelligent supervision for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Observe every turn, steer when the agent drifts, signal when the goal is reached._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

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
2. **Mid-run, only when needed** — checks after steering (to verify it worked) or as a safety valve after prolonged activity
3. **On completion** — supervisor signals done and stops automatically

The supervisor is a pure outside observer. It runs in a separate in-memory pi session sharing only the API credentials and never touches the main agent's context window or system prompt.

**Context for the supervisor LLM is built algorithmically** — no rolling buffers, no state accumulation. At each analysis point, the full conversation is processed through an internal compaction pipeline (ported from [pi-vcc](https://github.com/monotykamary/pi-vcc)) that produces a structured summary: session goals, file activity, outstanding errors, current status, and a compressed brief transcript. The supervisor LLM receives this rich, information-dense context fresh every time, built in ~1ms with zero API cost.

## Install

```bash
pi install npm:pi-supervisor
```

Or install from GitHub:

```bash
pi install https://github.com/monotykamary/pi-supervisor@master
```

Or load directly for development:

```bash
pi -e ~/projects/pi-supervisor/src/index.ts
```

## Commands

| Command                | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `/supervise`           | Auto-infer goal from conversation history                |
| `/supervise <outcome>` | Start supervising with explicit goal                     |
| `/supervise model`     | Pick the supervisor model (opens the model selector TUI) |
| `/supervise stop`      | Stop active supervision                                  |
| `/supervise widget`    | Toggle the status widget on/off                          |

### Examples

```
/supervise

/supervise Refactor the auth module to use dependency injection and add 90% test coverage

/supervise stop

/supervise model
```

The agent can also initiate supervision itself by calling the `start_supervision` tool — useful when it recognises a task needs goal tracking. The tool uses the global config model or active chat model; the AI cannot specify a model. Once active, supervision is locked: only the user can change or stop it.

When [pi-fabric](https://github.com/monotykamary/pi-fabric) is installed, pi-supervisor also registers a versioned Fabric provider. Fabric programs can discover `supervisor.start` and `supervisor.status` through `tools.search()` and invoke them with `tools.call()`. Stop and goal mutation remain user-only.

## UI

### Live Widget

The widget displays supervision state in a compact one-line format (text truncates to fit window width):

```
◉ Supervising · Goal: "Refactor auth module…" · ↗ 2 · steering
  The agent has added the DI container but hasn't updated the existing call sites yet…
```

Header states:

- **Inferring** — analyzing conversation to suggest a goal (`◉ Inferring · scanning`)
- **Supervising** — active supervision in progress
- **Supervised** — goal achieved, widget clears after delay

When the supervisor detects an ineffective pattern, the reframe tier appears (e.g., `↻2`):

```
◉ Supervising · Goal: "Implement payment flow…" · ↗ 5 · ↻2 · analyzing
  Breaking into smaller milestone: get the checkout form rendering first…
```

The thinking text streams naturally into multiple lines. When supervision ends or steers, thoughts animate away line-by-line from bottom to top (clearing newest first), then the widget clears. Toggle the widget with `/supervise widget`.

## How Supervision Works

**Analysis triggers:**

| When                          | Why                                              |
| ----------------------------- | ------------------------------------------------ |
| Agent goes idle (`agent_end`) | Critical decision point — must choose done/steer |
| After we steered              | Verify the steer worked                          |
| Mid-run safety valve          | Catch runaway drift during long runs             |
| Tool errors detected          | If agent hits an error, we check                 |

The supervisor only intervenes when it has high confidence the agent is off track. It trusts the agent to make progress and only steps in when necessary.

### Algorithmic Context Building

At each analysis point, the conversation is processed through an internal compaction pipeline — the same algorithm used by [pi-vcc](https://github.com/monotykamary/pi-vcc), but used here as a read-only transformation, not as a session compactor.

**Pipeline:** `normalize → filter noise → build sections → format`

| Step               | What it does                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Normalize**      | Raw Pi messages → uniform blocks (user, assistant, tool_call, tool_result, thinking, bash)                    |
| **Filter noise**   | Strip system messages, thinking blocks, noise tools (TodoWrite), XML wrappers                                 |
| **Build sections** | Extract session goals, file paths + symbols, type catalog, outstanding errors, current status, turn summaries |
| **Format**         | Render as bracketed sections + brief transcript for the supervisor LLM                                        |

**Properties:**

- **No LLM call** — purely algorithmic, zero extra API cost, ~1ms
- **Stateless** — built fresh from the full conversation each time, no rolling buffer or accumulated summary
- **Structured** — the supervisor LLM receives sections like `[Session Goal]`, `[Files And Changes]`, `[Outstanding Context]`, `[Current Status]` instead of a raw message dump

**Structured sections produced:**

| Section                 | Description                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `[Session Goal]`        | Initial goal + scope changes (regex-based extraction)                                                                |
| `[Files And Changes]`   | Modified/created/read files from tool calls, annotated with exported symbol names                                    |
| `[Commits]`             | Git commits made during the session (hash + first line)                                                              |
| `[Outstanding Context]` | Unresolved errors, test failures, tsc errors, empty search results — tagged `[ERROR]`/`[WARN]`/`[INFO]`/`[RESOLVED]` |
| `[Current Status]`      | Current focus, last file-modifying action, and next steps                                                            |
| `[Earlier Turns]`       | Per-turn one-liner summaries for every conversational turn                                                           |
| `[User Preferences]`    | Regex-extracted from user messages (`always`, `never`, `prefer`...)                                                  |
| Brief transcript        | Chronological conversation flow, tool calls collapsed to one-liners with `(#N)` refs                                 |

## Reframe Escalation

When the supervisor detects that steering isn't working, it escalates through **4 tiers** of reframing strategies rather than giving up:

| Tier | Trigger                   | Strategy                                                                   |
| ---- | ------------------------- | -------------------------------------------------------------------------- |
| 0    | (default)                 | Standard steering                                                          |
| 1    | Similar messages detected | **Directive** — be extremely specific about the next single action         |
| 2    | Pattern continues         | **Subgoal** — break the goal into a smaller, verifiable milestone          |
| 3    | Still stuck               | **Pivot** — suggest a completely different strategy or implementation path |
| 4    | Persistent stall          | **Minimal slice** — strip to absolute essentials, demand tangible output   |

**Pattern detection** tracks two indicators of ineffectiveness:

- **Message similarity** — when 2+ recent steering messages are similar (suggesting the agent isn't responding)
- **Stagnation** — when time passes without progress after a steer

When either pattern is detected, the supervisor escalates the reframe tier and injects tier-specific guidance into its prompt. The tier resets when the goal is achieved. This allows the supervisor to adapt to long-horizon projects that may take hours or days, rather than forcing early termination.

## Supervisor Model

The supervisor runs on a **separate model** — it can be a cheaper/faster model than the one doing the actual work.

**Resolution order:**

1. Previous session state (persists within a session)
2. `.pi/supervisor-config.json` in the project root (saved when you pick a model)
3. Active chat model (`ctx.model`) — so it works out of the box with no configuration

Change the supervisor model with `/supervise model` — it opens a copy of pi's own `/model` selector (DynamicBorder top/bottom, fuzzy search, all/scoped toggle) and saves the choice to `.pi/supervisor-config.json`. If supervision is already active, the live session model is updated too. Alternatively, start `/supervise <goal>` with a different chat model active, or delete `.pi/supervisor-config.json` to reset.

> **Works with [pi-model-sort](https://github.com/monotykamary/pi-model-sort):** the `/supervise model` picker reads pi-model-sort's last-used timestamps (`~/.pi/agent/extensions/pi-model-sort.json`) and lists models in the same recency order you see in pi's `/model` selector. With pi-model-sort absent or unused, it falls back to pi's default provider order. Selecting a model does **not** change your main chat model — the supervisor keeps its own.

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

The active source is shown when you run `/supervise <goal>` or when the tool is invoked.

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
  types.ts              # SupervisorState, SteeringDecision, ReframeTier
  compaction/           # Algorithmic context building (ported from pi-vcc)
    index.ts            # Public API: extractMessages(), buildCompactionSummary(), formatForSupervisor()
    normalize.ts        # Message[] → NormalizedBlock[]
    filter-noise.ts     # Strip thinking, TodoWrite, XML wrappers
    build-sections.ts   # Build all structured sections
    brief.ts            # Compressed [user]/[assistant]/[tool_error] transcript
    sanitize.ts         # ANSI/control char stripping
    content.ts          # Text utilities: clip, firstLine, textOf
    tool-args.ts        # Path extraction from tool arguments
    skill-collapse.ts   # Collapse <skill> XML blocks
    types.ts            # NormalizedBlock, ToolResultIndex, SectionData, SymbolRef
    extract/            # Section extractors
      goals.ts          # User goal + scope change extraction
      commits.ts        # Git commit extraction
      preferences.ts    # User preference extraction
      shared-symbols.ts # Unified file/symbol/type extraction
  state/                # State management
    manager.ts          # SupervisorStateManager — persistence, reframe tier, pattern detection
  core/                 # Core supervision logic
    analyzer.ts         # Main analysis engine (builds fresh compaction each call)
    inference.ts        # Goal inference from conversation
    prompt-loader.ts    # SUPERVISOR.md loading
  session/              # Model session management
    client.ts           # callSupervisorModel — one-shot analysis via reusable session
  ui/                   # User interface
    renderer.ts         # Widget rendering and footer management
    animations.ts       # Thought clearing animations
    types.ts            # Widget state types
    model-picker.ts      # Interactive model picker (opens the selector)
    model-settings-selector.ts # Copied pi-core ModelSelectorComponent for the supervisor
    model-sort.ts        # pi-model-sort last-used integration
  global-config.ts      # .pi/supervisor-config.json read/write
```

## License

MIT — [tintinweb](https://github.com/tintinweb) (forked by [monotykamary](https://github.com/monotykamary))
