# claudefiles

Two small [Claude Code](https://claude.com/claude-code) efficiency tools:

- **statusline** — a cost & context-efficiency status line. A standalone bash script
  (plugins can't ship a `statusLine`, so this one installs via a settings snippet).
- **guard** — a `PreToolUse` hook that blocks context-wasting tool calls and nudges
  toward scoped alternatives. Shipped as an installable plugin.

Both work unmodified across Pro/Max seat, enterprise, and API-key billing.

---

## statusline

[`statusline/statusline-command.sh`](statusline/statusline-command.sh) — a cost & context
dashboard. Example:

```
Fable 1M | medium | 5x | 5h:16% ↺2h | 7d:2% ↺3d | Δ10¢ | Σ$14.90 | 169k | waste: 3% | ❄18:10 | claudefiles
```

| Segment | Meaning |
| --- | --- |
| `Fable 1M` | model (and context window) |
| `medium` | effort level |
| `5x` | cost multiplier vs Sonnet-low |
| `5h:16% ↺2h` | 5-hour rate-limit usage and reset (only when the account reports it) |
| `7d:2% ↺3d` | weekly rate limit and reset |
| `Δ10¢` | last-turn cost |
| `Σ$14.90` | session cost so far |
| `169k` | context tokens in use |
| `waste: 3%` | uncached-input share |
| `❄18:10` | prompt-cache expiry |
| `claudefiles` | cwd |

Costs come from the session transcript at public **API list prices** — on a flat-rate seat
the dollar figures are notional, not what you're billed. The prompt-cache TTL is detected
from actual usage.

Requires `bash` and `jq`.

### Install

Add to `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/path/to/claudefiles/statusline/statusline-command.sh",
    "refreshInterval": 5 // optional
  }
}
```

## guard

A single [`hooks/guard.mjs`](hooks/guard.mjs) dispatched on `Read`, `Bash`, `WebFetch`,
and `LSP`. It denies a call (with a one-line reason pointing at the better tool) when it
sees a pattern that needlessly burns context, and fails **open** on anything ambiguous —
any parse error, unreadable file, or unexpected throw allows the call through.

### What it blocks

| Tool | Pattern blocked | Why / what to do instead |
| --- | --- | --- |
| Bash | tree-wide `grep`/`rg` for a symbol-looking pattern | Scans the whole tree. Scope it: `grep -n foo src/`. |
| Bash | `cat`/`sed`/`awk`/`head`/`tail` of a code/JSON file | Use the Read tool — Edit needs a prior Read, so a `cat` only forces a duplicate read later. |
| Bash | a `grep`/read at a path that doesn't exist | A blind guess. `find`/`ls` to locate it first. |
| Bash | `find … -exec cat {}` | Dumps every matched file whole. Read the ones you need. |
| Bash | reading gated files in a `for`/`while` loop | Same — dumps each match whole. |
| Bash | `git show <ref>:<path>` of a large file | Dumps the whole file. Read the part you need. |
| Bash | two-dot `git diff A..B` | Compares endpoints, folding in unrelated changes. Use three-dot `A...B` (from the merge-base). |
| Read | a code/JSON file over the size gate, with no `limit` | Pulls the whole file. Pass a `limit` to scope the read. |
| WebFetch | a GitHub issue/PR/blob page | Noisy rendered HTML. Use the `gh` CLI or `raw.githubusercontent.com`. |
| LSP | `workspaceSymbol`, or `documentSymbol` on a large file | Dumps the whole symbol table/tree. Use `grep`/`findReferences`. (Dormant unless an LSP plugin is enabled.) |

### Configuration

Two optional environment variables (defaults preserve the behavior above exactly):

| Variable | Default | Effect |
| --- | --- | --- |
| `GUARD_MAX_KB` | `16` | Size gate (KB) for whole-file reads/dumps. |
| `GUARD_EXTRA_EXT` | — | Comma-separated extensions appended to the gated list, e.g. `py,go,rs`. |

### Install (plugin)

```
/plugin marketplace add mourner/claudefiles
/plugin install claudefiles@claudefiles
```

To set `GUARD_MAX_KB` / `GUARD_EXTRA_EXT`, export them in the environment Claude Code runs in.

### Install (manual hook)

If you'd rather not use the plugin, point a `PreToolUse` hook at the script directly in
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Bash|WebFetch|LSP",
        "hooks": [
          { "type": "command", "command": "node \"$HOME/path/to/claudefiles/hooks/guard.mjs\"" }
        ]
      }
    ]
  }
}
```

A machine-wide guard composes with per-repo `.claude/hooks/guard.mjs` hooks: Claude Code
runs every matching hook and blocks if any one denies.
