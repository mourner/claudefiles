# claudefiles

A few small [Claude Code](https://claude.com/claude-code) efficiency tools:

- **statusline** — a cost & context-efficiency status line, a standalone bash script.
- **guard** — a small `PreToolUse` hook that blocks the few tool calls that clearly waste a
  lot of context or answer the wrong question.
- **js-perf-notes** — a skill: a reference of transferable JavaScript/V8 performance
  optimization principles, auto-consulted when profiling or optimizing hot code.

The guard and skill ship as the installable `claudefiles` plugin (with more tooling to come);
statusline installs via a one-line settings snippet, since plugins can't ship a `statusLine`.

## statusline

[`statusline/statusline-command.sh`](statusline/statusline-command.sh) — a custom status line
for efficiency-conscious sessions. It answers two questions at a glance: *how fast am I burning
through my quota?* and *what is this turn and session costing?* Requires `bash` and `jq`.

![Opus 1M medium 1.5x | 5h:16% ↺1h40m | 7d:46% ↺3d5h 0.8x | Δ0.1% Σ2.4% | 84k ❄32m | claudefiles](statusline/statusline.svg)

The first line is a relaxed session; the second is one worth a look. Reading left to right:

| Group | Segment | Meaning |
| --- | --- | --- |
| model | `Opus 1M` | model, with context-window size |
| | `medium` | effort level |
| | `1.5x` | roughly how much this model+effort costs per prompt, relative to Opus 5.5 at low effort (the 1x baseline) |
| limits | `5h:16% ↺1h40m` | 5-hour rate limit: used, and time until it resets |
| | `7d:46% ↺3d5h` | weekly rate limit: used, and time until it resets |
| | `0.8x` / `⚠1.3x` | burn-rate pace: where you'll land at reset if you keep going like this |
| cost | `Δ0.1%` | this turn's cost — starts at zero each prompt and climbs as the turn runs |
| | `Σ2.4%` | session cost so far |
| context | `84k` | context tokens in use |
| | `❄32m` | time left before the prompt cache expires — past it, the next turn pays full price to rebuild it instead of the cheap cached read |
| cwd | `claudefiles` | working directory |

The limits group shows only on accounts that report rate limits (subscription plans). On
API-billed accounts the costs show in dollars instead, e.g. `Δ10¢ Σ$14.90`.

### Quota burn

**Pace** is `used% ÷ elapsed%` for a limit's window, i.e. your projected usage at reset: `1.0x`
is dead on a linear budget line, `0.8x` leaves a fifth of the quota unused, and `1.3x` means
you'll hit the wall before reset if you keep it up. The weekly limit always shows it, plain below
`1.1x` and as a `⚠` warning above. The 5-hour limit shows it only as a warning. Neither shows in a
window's first 10% (`PACE_WARN` / `PACE_FLOOR` in the script).

**Turn and session costs** are shown as an estimated share of the weekly quota, so `Δ1.6%` means
that one turn ate 1.6% of your week. The estimate converts notional API cost at $3 per 1%
(`WEEK_PCT_M` in the script, measured with Opus 5.5 — other plans may differ), so treat it as
rough. Set `STATUSLINE_COST=1` in the status line command to show dollars instead, or `0` to hide
costs.

**Usage log.** Each session appends a line to `statusline-usage.log` in the Claude config dir
(`~/.claude`, or `CLAUDE_CONFIG_DIR`) whenever its notional cost or the 5h/7d percentages change:
`epoch session milli-$ 5h% 7d% 5h-reset 7d-reset model`. It's raw data for re-checking
`WEEK_PCT_M` after a plan or limit change.

### Costs and colors

**Costs** come from the session transcript at public API list prices — on a subscription the
dollar figures are *notional*, not what you're billed. They still track the *relative* weight of
what you're doing — which turns are expensive, what a model or effort change costs — so they work
as an efficiency signal even with no money on the line. The prompt-cache TTL is detected from
actual usage.

**Colors** run green → cyan → orange → red across segments, signaling fine → worth a glance.
The cost multiplier, rate limits, tokens, cache TTL, and pace badge each carry their own
thresholds, so a red anywhere is the one thing to look at.

The picture above is generated from the script's real output with `npm run svg`
([`statusline/svg.js`](statusline/svg.js)), so rerun it after changing the format.

### Install

Add to `settings.json`:

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

A single [`hooks/guard.mjs`](hooks/guard.mjs) that runs before every `Read`, `Bash` and
`WebFetch` call. When it recognizes a call that would clearly burn context or answer the
wrong question, it blocks it and returns a one-line reason naming the alternative.

It only blocks patterns it's sure about. Anything it can't parse, a file it can't read, or
an unexpected error all let the call through — the guard never blocks a call it doesn't
understand, so a bug in it can't bring your work to a halt.

### What it blocks

| Tool | Pattern blocked | Why / what to do instead |
| --- | --- | --- |
| Bash | `cat` of a file over 64 KB, unpiped and unredirected | Goes straight into context. Filter it (`grep`, `jq`, `head`) or read a slice. |
| Bash | two-dot `git diff A..B` | Compares endpoints, folding in unrelated changes. Use three-dot `A...B` (from the merge-base). |
| Read | a file over 64 KB, with no `limit`/`offset` | Pulls the whole file. Pass a `limit` to scope the read. |
| WebFetch | a GitHub issue/PR/blob page | Noisy rendered HTML. Use the `gh` CLI or `raw.githubusercontent.com`. |

The 64 KB ceiling is a constant at the top of [`hooks/guard.mjs`](hooks/guard.mjs) — edit it
there if your work wants a different limit.

### Install (plugin)

```
/plugin marketplace add mourner/claudefiles
/plugin install claudefiles@mourner
```

### Install (manual hook)

If you'd rather not use the plugin, point a `PreToolUse` hook at the script directly in
`~/.claude/settings.json`:

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

This machine-wide guard stacks with any per-repo `.claude/hooks/guard.mjs`: Claude Code runs
every matching hook on a call and blocks it if any one of them does.

## js-perf-notes (skill)

[`skills/js-perf-notes/SKILL.md`](skills/js-perf-notes/SKILL.md) — a distilled,
project-agnostic reference of JavaScript/V8 performance-optimization principles: a profiling
loop, headless tooling (`flamebearer`, `--trace-deopt`), benchmarking against noise, and
honest reporting. Bottleneck-specific V8 techniques (inlining budgets, SMI range, hidden
classes, cache/memory layout) live in on-demand files under `skills/js-perf-notes/techniques/`.
It's a *reference to consult*, not a workflow to run — Claude pulls it in on its own when a
task is about profiling or optimizing hot code.

### Install (plugin)

Ships with the `claudefiles` plugin (see the guard install above) — no extra step.

### Install (manual symlink)

If you'd rather not use the plugin, symlink the skill into your personal skills directory:

```
mkdir -p ~/.claude/skills
ln -s ~/path/to/claudefiles/skills/js-perf-notes ~/.claude/skills/js-perf-notes
```
