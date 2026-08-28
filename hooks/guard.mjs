// Generic PreToolUse guard for Read, Bash and WebFetch. One script, dispatched by tool_name at the
// bottom. Each check inspects tool_input and calls deny() to block the call; returning without
// denying allows it. Fail-open by design: any parse/read error or unexpected throw → allow.
//
// This is the machine-wide guard installed in ~/.claude. Project-specific guards (e.g. "use the
// repo's npm test scripts, not bare vitest") live in a per-repo .claude/hooks/guard.mjs; Claude
// Code runs every matching PreToolUse hook and blocks if any one denies, so the two compose.
//
// WHAT BELONGS HERE. A rule earns its place only if it rests on an invariant *outside* the harness —
// git semantics, how GitHub serves HTML, the arithmetic of a context window. Rules that encoded
// harness policy ("prefer the Read tool over cat", "Edit needs a prior Read") used to live here and
// were removed: the harness changed under them, and in bash-first auto mode — where the system
// prompt asks for cat/sed/grep and the Grep and Glob tools are gone — they inverted, costing a
// round-trip to enforce a preference the platform no longer holds. A deny is never free: it costs
// the failed call, the reason, and the retry, all re-sent for the rest of the session. So a rule
// that fires on anything but a clear, large win is a net loss. Prefer deleting to tuning.
//
// Bash:
//   - block an unpiped, unredirected `cat` of a file over the size ceiling (it goes straight to
//     context). Only `cat`: head/tail are bounded by construction, awk output is program-derived,
//     and sed is how auto mode *edits* — gating it would block writes, not reads.
//   - block two-dot `git diff A..B` branch ranges (use three-dot A...B from the merge-base)
// Read:
//   - block an unscoped read of a file over the size ceiling (a present `limit`/`offset` is the
//     escape hatch). Read's own 2000-line cap covers ordinary files; this catches the long-line
//     case — minified bundles, generated JSON — where few lines still mean hundreds of KB.
// WebFetch:
//   - block fetching a GitHub issue/PR/blob page (noisy rendered HTML) — use the gh CLI instead

import {readFileSync, realpathSync, statSync} from 'fs';
import {fileURLToPath} from 'url';

// Block threshold in bytes. Bytes track context tokens (~3–4 chars/token for code) far better than
// line count, which a verbose line or a minified one-liner both defeat.
//
// 64 KB is ~18k tokens — too much to spend on one call, and past the point where anyone wants a file
// whole rather than a region. The ceiling is deliberately just *under* the ~80 KB where Read's own
// 2000-line cap starts truncating: at a measured median 41 bytes/line, that cap already handles
// ordinary code above 80 KB, so a higher ceiling would only duplicate it. Below it the gate is the
// sole defense — 3 in 4 large files run under 2000 lines, and `cat` has no cap at all.
//
// Calibrated against ~4,600 real source files: 64 KB is ~1 in 57, a backstop rate. Lower it toward
// 48 KB to bite more often; going much past 64 KB starts letting real 80–120 KB source files through.
const MAX_BYTES = 64 * 1024;

// A deny is thrown (not written) so the checks can bail from deep in the call stack; decide() catches
// it and returns the reason, while any *other* throw falls through to allow (fail-open).
class Deny {
    constructor(reason) { this.reason = reason; }
}
function deny(reason) {
    throw new Deny(reason);
}

// Size of a file in bytes, or null if it can't be stat'd — a missing path, a directory, or a token
// the shell would have expanded (a glob, `$var`, `~`). Callers fail open on null, so no separate
// existence or expansion check is needed. Uses `statSync` so we never read a multi-megabyte file
// into the hook just to measure it.
function fileSize(path) {
    try {
        const st = statSync(path);
        return st.isFile() ? st.size : null;
    } catch {
        return null;
    }
}

const kb = bytes => Math.round(bytes / 1024);

// ── Bash ──────────────────────────────────────────────────────────────────────────────────────

// Shared regexes, kept at module scope so they compile once rather than on every guard call.
// A *stdout* redirect: `>`/`>>`/`&>`/`foo>out`, but NOT a stderr-only `2>`/`2>&1` — those leave the
// file content flowing to stdout (and into context). The lookbehind also skips `<>`/`<<` and the
// second `>` of `>>`.
const REDIRECT = /(?<![<2>])>/;
const GIT_DIFF_RANGE = /^([\w@~^/.-]+)\.\.([\w@~^/.-]+)$/; // two-dot `A..B` ref range
const HEREDOC_OPEN = /<<-?\s*['"]?(\w+)['"]?/;             // heredoc opener, capturing the delimiter
// Shell command separators, including a single background `&` (`echo hi & cat big.json` runs both).
// The lookarounds keep `&&` (handled by its own alternative), `2>&1`, `<&3` and `&>out` in one piece.
const SEGMENT_SPLIT = /&&|\|\||;|\n|(?<![<>&])&(?![&>])/;
const WHITESPACE = /\s+/;
const DIGITS = /^\d+$/;

const unquote = s => s.length >= 2 && (s[0] === '"' || s[0] === '\'') && s.at(-1) === s[0] ? s.slice(1, -1) : s;

// Shell keywords that can precede the real command word at the start of a segment (loop/conditional
// bodies, subshells, negation). Stripping them lets us read `then git diff a..b` as a `git` command.
const LEAD_KW = new Set(['do', 'then', 'else', 'elif', '{', '(', '!']);
const stripLead = (tokens) => {
    let i = 0;
    while (i < tokens.length && LEAD_KW.has(tokens[i])) i++;
    return tokens.slice(i);
};

// Wrapper commands that execute their argument list as a command — the real command word follows
// them (possibly after the wrapper's own flags, or a duration for `timeout`). `VAR=x` prefix
// assignments are skipped the same way.
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'env', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'xargs']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/; // `timeout 5`, `timeout 2.5s`

// Index of the segment's effective command word, or -1. Checks key off this position so
// `sudo cat …` is still a cat but `echo cat …` / `git commit -m "… cat …"` are not — a command
// merely *named* in another command's arguments isn't being run. Best-effort (a wrapper flag that
// takes a value, like `sudo -u root`, derails it), which only ever fails open.
function cmdAt(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (ASSIGNMENT.test(t)) continue;
        if (WRAPPERS.has(t)) {
            while (i + 1 < tokens.length) {
                const next = tokens[i + 1];
                if (next.startsWith('-') || (t === 'timeout' && DURATION.test(next))) i++;
                else break;
            }
            continue;
        }
        return i;
    }
    return -1;
}

// `cat <big file>` with nowhere else to go sends every byte to stdout and therefore into context.
// Scoped to `cat` alone, and only when the whole file really would land in context:
//   - piped (`cat big.json | jq .deps`) → the downstream stage bounds what surfaces
//   - redirected (`cat a b > merged`, `cat > f <<EOF`) → the bytes go to a file
// The size gate does the rest of the false-positive suppression for free: the argument has to be a
// real file on disk *and* over the ceiling, so a `cat` inside quoted text or a `$var` path that
// can't be stat'd simply fails open. No extension list — a 300 KB anything is too big to dump.
function checkBigCat(tokens) {
    const ci = cmdAt(tokens);
    if (ci === -1 || tokens[ci] !== 'cat') return;
    for (const tok of tokens.slice(ci + 1)) {
        const t = unquote(tok);
        if (t.startsWith('-')) continue;
        const size = fileSize(t);
        if (size != null && size > MAX_BYTES) {
            deny(`\`cat ${t}\` would put ${kb(size)} KB straight into context. Filter it instead ` +
                '(`grep`, `jq`, `head`), or read a slice with the Read tool (`offset`+`limit`).');
        }
    }
}

// `git diff A..B` (two dots) compares the two endpoints — identical to `git diff A B` — so once
// `main` has advanced past the branch point it folds main-only commits into the diff (showing as
// spurious reversals). For "what THIS branch changed" you want three dots: `git diff A...B` diffs
// from the merge-base. Only the two-dot range form is blocked; `git diff A B` (space) and explicit
// paths like `git diff -- ../foo` are left alone. The escape hatch is the space form.
//
// Unlike everything else here this is a correctness rule, not a token rule: the two-dot form
// silently answers a different question than the one being asked.
function checkGitDiff(tokens) {
    const gi = cmdAt(tokens);
    if (gi === -1 || tokens[gi] !== 'git' || tokens[gi + 1] !== 'diff') return;
    for (const tok of tokens.slice(gi + 2)) {
        if (tok === '--') return;          // pathspecs follow — stop scanning
        if (tok.startsWith('-')) continue; // flag
        const t = unquote(tok);
        if (!t.includes('..') || t.includes('...')) continue; // only bare two-dot ranges
        const m = t.match(GIT_DIFF_RANGE);
        if (!m || m[1].endsWith('/') || m[2].startsWith('/')) continue; // looks like a path, not a ref range
        deny(`\`git diff ${t}\` compares endpoints (= \`git diff ${m[1]} ${m[2]}\`); if ${m[1]} has ` +
            `advanced it folds in ${m[1]}-only changes. For what this branch changed, use three dots: ` +
            `\`git diff ${m[1]}...${m[2]}\` (diffs from the merge-base).`);
    }
}

// Drop heredoc bodies: their content is file data being written, not commands, so scanning them
// (now that we split on newlines) would flag a script being authored that happens to contain
// `git diff a..b`. We keep the opener line and drop everything up to the closing delimiter.
// Dropping only ever makes us more permissive (fail-open), never causes a false deny — including
// if `<<` wasn't a heredoc at all.
function stripHeredocs(cmd) {
    const out = [];
    let delim = null;
    for (const line of cmd.split('\n')) {
        if (delim != null) {
            if (line.trim() === delim) delim = null; // closing line — drop it too
            continue;
        }
        const m = line.match(HEREDOC_OPEN);
        if (m) delim = m[1];
        out.push(line);
    }
    return out.join('\n');
}

function checkBash(input) {
    if (typeof input.command !== 'string') return;
    const cmd = stripHeredocs(input.command);

    // A command line can chain independent commands (`&&`, `||`, `;`, newlines) and open loop or
    // conditional bodies, each of which can dump on its own — so judging from the first command
    // alone misses the rest. Split into segments, strip leading shell keywords, and run each check
    // on the segment's first pipe stage (only that stage touches disk; later stages filter stdout).
    // Best-effort: a separator inside quotes may mis-split, which only ever makes us fail open.
    const segments = cmd.split(SEGMENT_SPLIT);

    for (const segment of segments) {
        const stages = segment.split('|');
        const tokens = stripLead(stages[0].split(WHITESPACE).filter(Boolean));
        if (tokens.length === 0) continue;
        checkGitDiff(tokens);
        // A pipe or a stdout redirect means the bytes are bounded downstream or land in a file
        // rather than in context — either way, outside this check's charter.
        if (stages.length === 1 && !REDIRECT.test(segment)) checkBigCat(tokens);
    }
}

// ── Read ──────────────────────────────────────────────────────────────────────────────────────

function checkRead(input) {
    const filePath = input.file_path;
    // A present `limit` OR `offset` is the escape hatch — either one shows the read is already a
    // deliberate slice, which is all this gate is trying to induce.
    if (typeof filePath !== 'string' || input.limit != null || input.offset != null) return;

    const size = fileSize(filePath);
    if (size != null && size > MAX_BYTES) {
        deny(`${kb(size)} KB — too big to read whole. Read the part you need with \`offset\`+\`limit\`, ` +
            `or \`grep -n '<name>' ${filePath}\` to locate it first.`);
    }
}

// ── WebFetch ────────────────────────────────────────────────────────────────────────────────────

// Fetching a GitHub issue/PR/blob page pulls down the whole rendered HTML chrome — nav, sidebars,
// reactions — for a few KB of actual content. The gh CLI returns the same thing as clean JSON/text
// for a fraction of the tokens. Block those URLs and name the equivalent command. Other github.com
// URLs (and everything off github.com) fail open.
function checkWebFetch(input) {
    if (typeof input.url !== 'string') return;
    let u;
    try { u = new URL(input.url); } catch { return; }
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return;

    const [owner, repo, kind, ...rest] = u.pathname.split('/').filter(Boolean);
    if (!owner || !repo || !kind) return;
    const slug = `${owner}/${repo}`;

    if ((kind === 'issues' || kind === 'pull') && DIGITS.test(rest[0])) {
        const sub = kind === 'pull' ? 'pr' : 'issue';
        const label = kind === 'pull' ? 'PR' : 'issue';
        deny(`Fetching a GitHub ${label} page pulls noisy rendered HTML. Use the gh CLI for clean JSON: ` +
            `\`gh ${sub} view ${rest[0]} --repo ${slug} --json title,body,comments\`.`);
    }
    if (kind === 'blob' && rest.length >= 2) {
        const [ref, ...pathParts] = rest;
        const path = pathParts.join('/');
        deny('Fetching a GitHub blob page pulls the whole rendered HTML. Get the raw file instead: ' +
            `\`curl -s https://raw.githubusercontent.com/${slug}/${ref}/${path}\` ` +
            `(or \`gh api repos/${slug}/contents/${path}?ref=${ref} --jq .content | base64 -d\`).`);
    }
}

// ── Decision core ───────────────────────────────────────────────────────────────────────────────

// Pure entry point: given a hook payload, return the deny reason string, or null to allow. Fail-open
// — a Deny thrown by a check becomes its reason; any other throw (bad input, stat error, check bug)
// falls through to allow. Exported so the test suite can exercise the logic in-process.
export function decide({tool_name: toolName, tool_input: toolInput} = {}) {
    const input = toolInput ?? {};
    try {
        if (toolName === 'Bash') checkBash(input);
        else if (toolName === 'Read') checkRead(input);
        else if (toolName === 'WebFetch') checkWebFetch(input);
    } catch (e) {
        if (e instanceof Deny) return e.reason;
        // parse/read error or check bug → fall through to allow
    }
    return null;
}

// ── CLI entry (the actual PreToolUse hook) ──────────────────────────────────────────────────────
// Run only when invoked as a script, not when imported by the tests. Both sides of the comparison
// go through realpath: Node resolves the main module URL through symlinks while argv[1] stays
// literal, so a symlinked install path would otherwise never match — and the guard would silently
// allow everything while looking installed. Reads the payload JSON from stdin and, on a deny,
// writes the hook's decision JSON to stdout. A malformed payload → allow.
let isMain = false;
try {
    isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* no argv[1] or vanished path → not a direct invocation */ }
if (isMain) {
    let reason = null;
    try {
        reason = decide(JSON.parse(readFileSync(0, 'utf8')));
    } catch {
        // stdin parse error → allow
    }
    if (reason != null) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
        }));
    }
    process.exit(0);
}
