// Generic PreToolUse guard for Read, Bash, WebFetch, and LSP. One script, dispatched by tool_name
// at the bottom. Each check inspects tool_input and calls deny() to block the call; returning
// without denying allows it. Fail-open by design: any parse/read error or unexpected throw → allow.
//
// This is the machine-wide guard installed in ~/.claude. Project-specific guards (e.g. "use the
// repo's npm test scripts, not bare vitest") live in a per-repo .claude/hooks/guard.mjs; Claude
// Code runs every matching PreToolUse hook and blocks if any one denies, so the two compose.
//
// Bash:
//   - block bare whole-tree `grep`/`rg` for a symbol-looking pattern (scope it to a subdir)
//   - block sed/awk/head/tail/cat range-reads of a code/JSON file (use the Read tool)
//   - block guessed grep targets that don't exist (use `find` first)
//   - block `git show <ref>:<path>` whole-file dumps of a code/JSON file (use git checkout / sed)
//   - block two-dot `git diff A..B` branch ranges (use three-dot A...B from the merge-base)
// Read:
//   - block an unscoped read of a >16 KB code or JSON file (a present `limit` is the escape hatch)
// WebFetch:
//   - block fetching a GitHub issue/PR/blob page (noisy rendered HTML) — use the gh CLI instead
// LSP (dormant — plugin disabled by default, fires only if re-enabled):
//   - hard-deny `workspaceSymbol`; deny `documentSymbol` on a large file

import {existsSync, readFileSync, statSync} from 'fs';
import {fileURLToPath} from 'url';

// Block threshold in bytes. Bytes track context tokens (~4 chars/token) far better than line count,
// which a verbose line or a minified one-liner both defeat. 16 KB leaves the typical 3–4 KB module
// untouched and gates only the long tail where you almost always want a slice. Edit it here if your
// codebase wants a different ceiling.
const MAX_BYTES = 16 * 1024;

// Extensions whose unscoped whole-file read wastes context: source code across common languages,
// plus JSON/GeoJSON fixtures. Prose and data files (`.md/.txt/.log/.csv/.yaml/…`) stay exempt —
// you usually do want the whole document. Add or remove extensions here as needed.
const GATED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|geojson|py|pyi|rb|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hh|cs|php|swift|scala|clj|cljs|ex|exs|erl|hs|ml|lua|r|jl|dart|vue|svelte|sh|bash|zsh|sql|pl|pm|groovy|gradle|proto)$/i;

// A deny is thrown (not written) so the checks can bail from deep in the call stack; decide() catches
// it and returns the reason, while any *other* throw falls through to allow (fail-open).
class Deny {
    constructor(reason) { this.reason = reason; }
}
function deny(reason) {
    throw new Deny(reason);
}

// Size of a file in bytes, or null if it can't be stat'd (caller fails open on null). Uses
// `statSync` so we never read a multi-megabyte file into the hook just to measure it.
function fileSize(path) {
    try {
        return statSync(path).size;
    } catch {
        return null;
    }
}

const kb = bytes => Math.round(bytes / 1024);

// ── Bash ──────────────────────────────────────────────────────────────────────────────────────

const SYMBOL = [
    /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/, // camelCase
    /^[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*$/, // PascalCase
];
const ALLOWLIST = /^(TODO|FIXME|HACK|XXX|NOTE)$/;
const GREP = new Set(['grep', 'rg', 'egrep', 'fgrep']);
const RANGE_READ = new Set(['cat', 'sed', 'awk', 'head', 'tail']);
const PAGER = new Set(['less', 'more']);

// Shared regexes, kept at module scope so they compile once rather than on every guard call.
const GREP_FILTER_FLAG = /^(--include|--exclude|-g)(=|$)/; // a scoping flag → grep is already bounded
const SHELL_EXPANSION = /[*?[\]{}$~`]/;                    // glob/$var/~/command-subst → not a static literal
const SED_INPLACE = /^-i/;                                 // `sed -i`/`-i.bak` → an edit, not a read
const REDIRECT = /[^<]>|^>/;                               // a bare `>`/`>>` output redirect (not `<<EOF`)
const GIT_DIFF_RANGE = /^([\w@~^/.-]+)\.\.([\w@~^/.-]+)$/; // two-dot `A..B` ref range
const HEREDOC_OPEN = /<<-?\s*['"]?(\w+)['"]?/;             // heredoc opener, capturing the delimiter
const SEGMENT_SPLIT = /&&|\|\||;|\n/;                      // shell command separators
const WHITESPACE = /\s+/;
const DIGITS = /^\d+$/;

const isSymbol = tok => typeof tok === 'string' && tok.length >= 4 && !ALLOWLIST.test(tok) && SYMBOL.some(rx => rx.test(tok));

const unquote = s => s.length >= 2 && (s[0] === '"' || s[0] === '\'') && s.at(-1) === s[0] ? s.slice(1, -1) : s;

// Shell keywords that can precede the real command word at the start of a segment (loop/conditional
// bodies, subshells, negation). Stripping them lets us read `do cat "$f"` as a `cat` command.
const LEAD_KW = new Set(['do', 'then', 'else', 'elif', '{', '(', '!']);
const stripLead = (tokens) => {
    let i = 0;
    while (i < tokens.length && LEAD_KW.has(tokens[i])) i++;
    return tokens.slice(i);
};

function checkGrep(tokens) {
    // Locate a grep/rg token that is NOT `git grep` (which is exempt).
    const gi = tokens.findIndex((t, i) => GREP.has(t) && tokens[i - 1] !== 'git');
    if (gi === -1) return;

    const positionals = [];
    for (const t of tokens.slice(gi + 1)) {
        if (GREP_FILTER_FLAG.test(t)) return; // a filter flag → already scoped
        if (!t.startsWith('-')) positionals.push(unquote(t)); // skip other flags
    }
    const pattern = positionals[0];
    if (!isSymbol(pattern)) return; // no pattern, or not symbol-shaped → fail open

    // Bare = no path, or path is the whole tree (`.` / `./`).
    const paths = positionals.slice(1).filter(p => p !== '.' && p !== './');
    if (paths.length > 0) {
        // A scoped grep is the escape hatch — UNLESS every target path is a literal that doesn't
        // exist. That's a guaranteed-empty path-guess; one `find` to learn the layout beats
        // flailing greps. Tokens the shell would expand (globs, $vars, ~, command subst) can't be
        // resolved statically, so they don't count as literal — we fail open on those.
        const literal = paths.filter(p => !SHELL_EXPANSION.test(p));
        if (literal.length === paths.length && literal.every(p => !existsSync(p))) {
            deny(`No such path: ${literal.join(', ')}. Use \`find\` to find the layout first.`);
        }
        return; // explicit existing subdir/file → scoped → allow
    }

    deny(`"${pattern}" looks like a symbol — scope it to a subdir: \`grep -n ${pattern} <dir>/\`. ` +
        'For tree-wide references, use your editor\'s LSP find-references.');
}

// Block cat/sed/awk/head/tail used to read a code or JSON file into context — the Read tool
// (offset/limit) does this cleanly. Only fires when such a path is present, so stream uses
// (e.g. `sed 's/a/b/'` on stdin) pass.
//
// This applies regardless of file size — it is NOT a context-waste rule (small files included).
// The Claude Code harness refuses to Edit a file that was not first read with the Read tool, so a
// `cat foo.ts` forces a second, duplicate read before any edit can happen. Routing the first read
// through the Read tool avoids that double-read. Hence: no size gate here, by design.
function checkRangeRead(tokens) {
    const cmd = tokens[0];
    if (!RANGE_READ.has(cmd)) return;
    const target = tokens.slice(1).map(unquote).find(t => GATED_EXT.test(t));
    if (!target) return;
    // `sed -i`/`-i.bak`/`--in-place`, `gawk -i inplace` are edits, not reads — let them through.
    if (tokens.some(t => SED_INPLACE.test(t) || t === '--in-place')) return;
    // A redirect (`>`/`>>`) or heredoc (`<<EOF`) means output goes to a file / is a heredoc body,
    // not into context — outside this guard's charter (and the matched path is the write target).
    // Catch redirects with no surrounding spaces too (`cat a.json>out`): any unquoted `>` not part
    // of a `<>`/`2>`-style construct still redirects output. `/[^<]>|^>/` matches a bare `>` token,
    // a `foo>bar` token, and `>>`, while skipping a lone `<<EOF`.
    if (tokens.some(t => t.startsWith('<<') || REDIRECT.test(t))) return;
    // A literal path that doesn't exist is a guess — point at `find`, like checkGrep does. Tokens
    // the shell would expand (globs, $vars, ~, command subst) can't be resolved statically, so we
    // skip them and fall through to the Read nudge.
    if (!SHELL_EXPANSION.test(target) && !existsSync(target)) {
        deny(`No such path: ${target}. Use \`find\`/\`ls\` to locate it first.`);
    }
    deny(`Use the Read tool (\`offset\`+\`limit\`) to read, not \`${cmd}\`.`);
}

// `find … -exec cat {} \;` (or -execdir, or piping the matches into one) bulk-dumps every matched
// file into context — the same whole-file dump checkRangeRead blocks, just fanned out by find. Fire
// when a segment's first stage is `find` whose -exec/-execdir command is a RANGE_READ. Fail open on
// anything else (a find with no range-read exec is fine).
function checkFindExec(tokens) {
    if (tokens[0] !== 'find') return;
    const ei = tokens.findIndex(t => t === '-exec' || t === '-execdir');
    if (ei === -1) return;
    if (RANGE_READ.has(tokens[ei + 1])) {
        deny(`\`find … ${tokens[ei]} ${tokens[ei + 1]} …\` dumps every matched file whole. ` +
            'Search across them with a scoped `rg <pattern> <paths>`, or read specific files with ' +
            'the Read tool (`offset`+`limit`).');
    }
}

// `git show <ref>:<path>` of a large code/JSON file dumps the whole file into context — usually a
// hand-revert (then Write) that `git checkout <ref> -- <path>` does with zero content. Only fires
// unpiped: `git show ...:... | sed -n` is a scoped inspect and is left alone (the caller's pipe
// already bounds the volume).
function checkGitShow(tokens) {
    const gi = tokens.indexOf('git');
    if (gi === -1 || tokens[gi + 1] !== 'show') return;
    for (const tok of tokens.slice(gi + 2)) {
        const t = unquote(tok);
        if (t.startsWith('-')) continue;
        const ci = t.indexOf(':');
        if (ci <= 0) continue; // need <ref>:<path>
        const [ref, path] = [t.slice(0, ci), t.slice(ci + 1)];
        if (!GATED_EXT.test(path)) return;
        const size = fileSize(path); // on-disk size as a proxy for the <ref> blob
        if (size == null) return; // path not on disk → can't size it → fail open
        if (size > MAX_BYTES) {
            deny(`\`git show ${ref}:${path}\` dumps the whole ${kb(size)} KB file. ` +
                `To revert, \`git checkout ${ref} -- ${path}\`; to inspect, pipe to \`sed -n 'A,Bp'\`.`);
        }
        return;
    }
}

// `git diff A..B` (two dots) compares the two endpoints — identical to `git diff A B` — so once
// `main` has advanced past the branch point it folds main-only commits into the diff (showing as
// spurious reversals). For "what THIS branch changed" you want three dots: `git diff A...B` diffs
// from the merge-base. Only the two-dot range form is blocked; `git diff A B` (space) and explicit
// paths like `git diff -- ../foo` are left alone. The escape hatch is the space form.
function checkGitDiff(tokens) {
    const gi = tokens.indexOf('git');
    if (gi === -1 || tokens[gi + 1] !== 'diff') return;
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
// (now that we split on newlines) would flag innocent script text like `find …` or `cat x.ts`.
// We keep the opener line and drop everything up to the closing delimiter. Dropping only ever makes
// us more permissive (fail-open), never causes a false deny — including if `<<` wasn't a heredoc.
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
    // conditional bodies (`for f in …; do cat "$f"; done`), each of which can read/dump on its own —
    // so judging from the first command alone misses the rest. Split into segments, strip leading
    // shell keywords, and run each check on the segment's first pipe stage (only that stage touches
    // disk; later stages filter stdout). Best-effort: a separator inside quotes may mis-split, which
    // only ever makes us fail open.
    const segments = cmd.split(SEGMENT_SPLIT);
    const segTokens = segments.map(s => stripLead(s.split('|')[0].split(WHITESPACE).filter(Boolean)));

    for (let i = 0; i < segments.length; i++) {
        const tokens = segTokens[i];
        if (tokens.length === 0) continue;
        const stages = segments[i].split('|');
        const piped = stages.length > 1;
        // A downstream pipe only bounds context when a stage actually *filters/derives* (grep, jq,
        // wc, …) — that's why a piped grep is left alone (checkGrep keys off the first stage). But
        // if every downstream stage is itself a raw slicer/pager (`cat x.ts | head -120`), the
        // pipeline still dumps a chunk of the file — exactly what the Read tool does with
        // offset+limit — so keep the range-read check on. git show stays exempt on any pipe (its
        // own check treats a downstream `sed -n` as a scoped inspect).
        const downstreamDumps = piped && stages.slice(1).every((s) => {
            const c = stripLead(s.trim().split(WHITESPACE).filter(Boolean))[0];
            return RANGE_READ.has(c) || PAGER.has(c);
        });
        if (!piped || downstreamDumps) checkRangeRead(tokens);
        checkGrep(tokens);
        checkFindExec(tokens);
        checkGitDiff(tokens);
        if (!piped) checkGitShow(tokens);
    }

    // `for f in a.ts b.ts; do cat "$f"; done` — the read target is the loop variable, so the
    // per-segment checkRangeRead (which keys off the file token) can't see it. Catch the shape:
    // a for/while whose in-list names gated files, with a range-read command in the loop body.
    const loopAt = segTokens.findIndex(t => (t[0] === 'for' || t[0] === 'while') && t.some(x => GATED_EXT.test(unquote(x))));
    if (loopAt !== -1) {
        const doneAt = segTokens.findIndex((t, i) => i > loopAt && t.includes('done'));
        const body = segTokens.slice(loopAt + 1, doneAt === -1 ? undefined : doneAt);
        if (body.some(t => RANGE_READ.has(t[0]))) {
            deny('Reading files in a loop dumps each one whole — read the parts you need with the ' +
                'Read tool (`offset`+`limit`), or search across them with a scoped `rg <pattern> <paths>`.');
        }
    }
}

// ── Read ──────────────────────────────────────────────────────────────────────────────────────

function checkRead(input) {
    const filePath = input.file_path;
    if (typeof filePath !== 'string' || input.limit != null) return; // a present `limit` is the escape hatch
    if (!GATED_EXT.test(filePath)) return; // logs/markdown/… always pass

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

// ── LSP (dormant safety net for if an LSP plugin is re-enabled) ──────────────────────────────────

function checkLsp(input) {
    if (input.operation === 'workspaceSymbol') {
        deny('`workspaceSymbol` dumps the whole symbol table. Use `grep -n \'<name>\' <dir>/` or `findReferences`.');
    }
    if (input.operation !== 'documentSymbol') return;

    const filePath = input.filePath;
    if (typeof filePath !== 'string') return;

    const size = fileSize(filePath);
    if (size != null && size > MAX_BYTES) {
        deny(`\`documentSymbol\` on a ${kb(size)} KB file dumps the whole tree — ` +
            `use \`grep -n '<name>' ${filePath}\` for a known name.`);
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
        else if (toolName === 'LSP') checkLsp(input);
    } catch (e) {
        if (e instanceof Deny) return e.reason;
        // parse/read error or check bug → fall through to allow
    }
    return null;
}

// ── CLI entry (the actual PreToolUse hook) ──────────────────────────────────────────────────────
// Run only when invoked as a script, not when imported by the tests. Reads the payload JSON from
// stdin and, on a deny, writes the hook's decision JSON to stdout. A malformed payload → allow.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
