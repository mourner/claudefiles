# claudefiles

Small [Claude Code](https://claude.com/claude-code) efficiency tools:

- **statusline** — a status line showing quota burn, costs and context.
- **guard** — a `PreToolUse` hook that blocks a few clearly wasteful tool calls.
- **js-perf-notes** — a skill with JavaScript/V8 performance optimization notes.

The guard and skill ship as the `claudefiles` plugin. The status line installs with a settings
snippet, since plugins can't ship one.

## statusline

[`statusline/statusline-command.sh`](statusline/statusline-command.sh) — a status line for
efficiency-conscious sessions. At a glance, it shows how fast you're burning through your
subscription quota, what the current turn and session cost, and when the prompt cache is about to
expire:

![Opus 1M medium 1.5x | 5h:16% ↺1h40m | 7d:46% ↺3d5h 0.8x | Δ0.1% Σ2.4% | 84k ❄32m | claudefiles](statusline/statusline.svg)

| Segment | Meaning |
| --- | --- |
| `Opus 1M medium` | model, context window, effort |
| `1.5x` | cost per prompt of this model+effort, relative to Opus 5.5 low |
| `5h:16% ↺1h40m` | 5-hour limit used, time until reset |
| `7d:46% ↺3d5h` | weekly limit used, time until reset |
| `0.8x` / `⚠1.3x` | pace: projected usage at reset, see below |
| `Δ0.1%` | this turn's cost as a share of the weekly quota, climbing as the turn runs |
| `Σ2.4%` | this session's cost, same |
| `84k` | context tokens in use |
| `❄32m` | time until the prompt cache expires — after that, the next turn pays full price to rebuild it |
| `claudefiles` | working directory |

Each segment has its own thresholds and colors go green → cyan → orange → red, so a red anywhere
is the thing to look at.

**Pace** is `used% ÷ elapsed%` for a limit's window: `1.0x` is right on budget, `0.8x` leaves a
fifth of the quota unused, `1.3x` hits the limit before reset. The weekly limit always shows it,
with a `⚠` above `1.1x`; the 5-hour limit shows only the warning. Hidden in a window's first 10%.

**Costs** are computed from the transcript at API list prices, so on a subscription they're
notional, but still show which turns are expensive and what a model or effort change costs. On
subscriptions they're shown as a share of the weekly quota at roughly $3 per 1% (`WEEK_PCT_M`,
measured with Opus 5.5 — treat it as rough). On API billing, or with `STATUSLINE_COST=1`, they
show in dollars; `STATUSLINE_COST=0` hides them.

**Usage log.** On subscriptions, each session appends cost and limit changes to
`statusline-usage.log` in the Claude config dir, for re-checking `WEEK_PCT_M` later.

The picture is generated from real output with `npm run svg`.

### Install

Requires `bash` and `jq`. Add to `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/path/to/claudefiles/statusline/statusline-command.sh",
    "refreshInterval": 5
  }
}
```

## guard

[`hooks/guard.mjs`](hooks/guard.mjs) runs before every `Read`, `Bash` and `WebFetch` call. When
it sees a call that would clearly burn context or answer the wrong question, it blocks it with a
one-line reason naming the alternative.

It only blocks patterns it's sure about: anything it can't parse, a file it can't read, or an
unexpected error lets the call through, so a bug in it can't stall your work.

| Tool | Blocked | Why / instead |
| --- | --- | --- |
| Bash | unpiped `cat` of a file over 64 KB | dumps it all into context; filter it (`grep`, `jq`, `head`) or read a slice |
| Bash | two-dot `git diff A..B` | compares endpoints, folding in unrelated changes; use three-dot `A...B` |
| Read | a file over 64 KB with no `limit`/`offset` | pulls the whole file; pass a `limit` |
| WebFetch | a GitHub issue/PR/blob page | noisy rendered HTML; use the `gh` CLI or `raw.githubusercontent.com` |

The 64 KB limit is a constant at the top of the script.

### Install (plugin)

```
/plugin marketplace add mourner/claudefiles
/plugin install claudefiles@mourner
```

### Install (manual hook)

Or add a `PreToolUse` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Bash|WebFetch",
        "hooks": [
          { "type": "command", "command": "node \"$HOME/path/to/claudefiles/hooks/guard.mjs\"" }
        ]
      }
    ]
  }
}
```

It stacks with any per-repo `.claude/hooks/guard.mjs`: a call is blocked if any hook blocks it.

## js-perf-notes (skill)

[`skills/js-perf-notes`](skills/js-perf-notes/SKILL.md) — JavaScript/V8 performance notes: a
profiling loop, headless tooling (`flamebearer`, `--trace-deopt`), noise-robust benchmarking, and
on-demand technique files (inlining, SMIs, hidden classes, memory layout). It's a reference to
consult, not a workflow to run — Claude pulls it in on its own when profiling or optimizing hot
code.

Ships with the plugin. Without it, symlink it into your skills directory:

```
mkdir -p ~/.claude/skills
ln -s ~/path/to/claudefiles/skills/js-perf-notes ~/.claude/skills/js-perf-notes
```
