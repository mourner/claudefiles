// Minimal tests for statusline-command.sh. The script reads a Claude Code status JSON
// object on stdin and prints one status line on stdout (with ANSI color codes). Each
// case feeds a hand-built input and asserts on the rendered, color-stripped line.
// Requires bash and jq on PATH — the same dependencies the status line itself needs.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'statusline-command.sh');

// Run the script with a JSON status object and return its output with ANSI codes stripped.
function render(status, env = {}) {
    const {stdout} = spawnSync('bash', [SCRIPT], {
        input: JSON.stringify(status), encoding: 'utf8', env: {...process.env, ...env},
    });
    // eslint-disable-next-line no-control-regex
    return (stdout ?? '').replace(/\[[0-9;]*m/g, '').trim();
}

// A minimal-but-complete status object; individual tests override what they exercise.
function status(overrides = {}) {
    return {
        model: {display_name: 'Sonnet', id: 'claude-sonnet-4-6'},
        effort: {level: 'medium'},
        context_window: {context_window_size: 200000, current_usage: {}},
        workspace: {current_dir: '/home/me/myproject'},
        ...overrides,
    };
}

test('statusline renders the model label, effort, multiplier, context and cwd', () => {
    const line = render(status());
    const segs = line.split(' | ');
    const model = segs[0].split(' ');          // model group: label, effort, multiplier
    assert.equal(model[0], 'Sonnet');
    assert.equal(model[1], 'medium');
    assert.match(model[2], /^\d+(\.\d+)?x$/);   // cost multiplier
    assert.equal(segs.at(-1), 'myproject');    // cwd basename
});

test('cost multiplier weighs cache read rates against the Opus 5.5 low baseline', () => {
    const mult = (id, level) => render(status({model: {display_name: 'x', id}, effort: {level}})).split(' | ')[0].split(' ').at(-1);
    assert.equal(mult('claude-opus-5-5', 'low'), '1x');
    assert.equal(mult('claude-opus-5', 'low'), '1.7x');
    assert.equal(mult('claude-fable-5-2', 'low'), '1.7x');
    assert.equal(mult('claude-fable-5-1', 'low'), '2.1x');
    assert.equal(mult('claude-fable-5', 'low'), '3.3x');
});

test('statusline appends "1M" to the model label when the context window is 1M', () => {
    const line = render(status({
        model: {display_name: 'Fable', id: 'claude-fable-5'},
        context_window: {context_window_size: 1000000, current_usage: {}},
    }));
    assert.match(line.split(' | ')[0], /^Fable 1M /);
});

test('statusline formats context tokens in thousands', () => {
    const line = render(status({
        context_window: {context_window_size: 200000, current_usage: {input_tokens: 169000}},
    }));
    assert.match(line, /\b169k\b/, line);
});

test('statusline hides the context group until the session has token usage', () => {
    const before = render(status({context_window: {context_window_size: 200000, current_usage: {}}}));
    assert.ok(!/❄/.test(before), before);

    const after = render(status({context_window: {context_window_size: 200000, current_usage: {input_tokens: 12000}}}));
    assert.match(after, /❄/, after);
    assert.match(after, /\b12k\b/, after);
});

test('statusline rate-limit segments render only when the account reports them', () => {
    const without = render(status());
    assert.ok(!/\b5h:/.test(without), without);

    const withLimits = render(status({
        rate_limits: {five_hour: {used_percentage: 16}, seven_day: {used_percentage: 2}},
    }));
    assert.match(withLimits, /5h:16%/);
    assert.match(withLimits, /7d:2%/);
});

test('statusline shows the limit reset hint after a space, limits joined by a pipe', () => {
    const now = Math.floor(Date.now() / 1000);
    const line = render(status({
        rate_limits: {
            five_hour: {used_percentage: 16, resets_at: now + 7200 + 60},
            seven_day: {used_percentage: 2, resets_at: now + 3 * 86400 + 60},
        },
    }));
    assert.match(line, /5h:16% ↺2h\d+m \| 7d:2% ↺3d\dh/);
});

test('statusline zeroes a rate limit once its reset deadline has passed (stale rollover)', () => {
    const now = Math.floor(Date.now() / 1000);
    const line = render(status({
        rate_limits: {
            five_hour: {used_percentage: 101, resets_at: now - 60},
            seven_day: {used_percentage: 2, resets_at: now + 3 * 86400 + 60},
        },
    }));
    assert.match(line, /5h:0%/);
    assert.ok(!line.includes('101%'), line);
});

test('statusline shows a burn-rate flag when over-pace, but not once at/over the limit', () => {
    const now = Math.floor(Date.now() / 1000);
    // half the 5h window elapsed (resets in 2.5h) at 90% used → pace 1.8x
    const overPace = render(status({
        rate_limits: {five_hour: {used_percentage: 90, resets_at: now + 9000}},
    }));
    assert.match(overPace, /⚠1\.8x/, overPace);

    // same pacing but already over the limit → no burn-rate flag
    const maxed = render(status({
        rate_limits: {five_hour: {used_percentage: 108, resets_at: now + 9000}},
    }));
    assert.ok(!maxed.includes('⚠'), maxed);
});

test('weekly pace shows plain under the warning threshold, 5h pace only as a warning', () => {
    const now = Math.floor(Date.now() / 1000);
    // 7d: 3.5 of 7 days elapsed at 40% used → 0.8x; 5h: half elapsed at 40% → 0.8x, hidden
    const line = render(status({
        rate_limits: {
            five_hour: {used_percentage: 40, resets_at: now + 9000},
            seven_day: {used_percentage: 40, resets_at: now + 302400},
        },
    }));
    assert.match(line, /5h:40% ↺2h\d+m \| 7d:40% ↺3d\d+h 0\.8x/, line);
    assert.ok(!line.includes('⚠'), line);
});

test('costs show as a share of the 7d quota on quota accounts, dollars with STATUSLINE_COST=1', () => {
    const quota = cost => status({cost: {total_cost_usd: cost}, rate_limits: {seven_day: {used_percentage: 2}}});
    assert.ok(render(quota(14.9)).includes('Σ5.0%'), render(quota(14.9)));
    assert.ok(render(quota(45)).includes('Σ15%'), render(quota(45)));
    assert.ok(render(quota(14.9), {STATUSLINE_COST: '1'}).includes('Σ$14.90'));
    assert.ok(!render(quota(14.9), {STATUSLINE_COST: '0'}).includes('Σ'));
    assert.ok(!render(status({cost: {total_cost_usd: 14.9}}), {STATUSLINE_COST: '0'}).includes('Σ'));
});

test('quota accounts log usage changes next to the projects dir, deduped per session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-'));
    mkdirSync(join(dir, 'projects', 'p'), {recursive: true});
    const transcript = join(dir, 'projects', 'p', 's1.jsonl');
    writeFileSync(transcript, '');
    const s = week => status({session_id: 's1', transcript_path: transcript,
        rate_limits: {seven_day: {used_percentage: week}}});
    render(s(2)); render(s(2)); render(s(3));
    const lines = readFileSync(join(dir, 'statusline-usage.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[1], /^\d+ s1 0 - 3 - - claude-sonnet-4-6$/);
});

test('statusline session cost uses total_cost_usd when present', () => {
    const line = render(status({cost: {total_cost_usd: 14.9}}));
    assert.ok(line.includes('Σ$14.90'), line);
});

// Cache-read-only transcript for `model`, priced from the public table: 10M cached tokens
// cost $10 on Fable 5 (0.1x of $10 input) but $2.50 on Fable 5.1 (cache read $0.25/MTok)
// and $2 on Fable 5.2 and Opus 5.5 (cache read $0.20/MTok).
function writeCacheReadTranscript(model) {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-'));
    const path = join(dir, 'transcript.jsonl');
    const iso = new Date().toISOString();
    writeFileSync(path, `${[
        JSON.stringify({type: 'user', timestamp: iso, message: {content: 'hi'}}),
        JSON.stringify({type: 'assistant', timestamp: iso, message: {
            id: 'a1', model, usage: {cache_read_input_tokens: 10000000},
        }}),
    ].join('\n')}\n`);
    return path;
}

test('Fable 5.1/5.2 and Opus 5.5 cache reads have own rates, other models 0.1x', () => {
    const cost = model => render(status({transcript_path: writeCacheReadTranscript(model)}));
    assert.ok(cost('claude-fable-5-2').includes('Σ$2.00'), cost('claude-fable-5-2'));
    assert.ok(cost('claude-fable-5-1').includes('Σ$2.50'), cost('claude-fable-5-1'));
    assert.ok(cost('claude-fable-5').includes('Σ$10.00'), cost('claude-fable-5'));
    assert.ok(cost('claude-opus-5').includes('Σ$5.00'), cost('claude-opus-5'));
    assert.ok(cost('claude-opus-5-5').includes('Σ$2.00'), cost('claude-opus-5-5'));
});

// Write a transcript JSONL with a single 1h-cache-writing assistant turn `ageSec`
// seconds ago, optionally followed by a fresh non-cache system row (as a session
// resume appends). Returns the path. The file's mtime ends up "now", so any code
// keying the countdown off mtime would wrongly see the cache as fresh.
function writeTranscript({ageSec, trailingSystem, prompt = 'hi'}) {
    const dir = mkdtempSync(join(tmpdir(), 'statusline-'));
    const path = join(dir, 'transcript.jsonl');
    const iso = s => new Date((Math.floor(Date.now() / 1000) - s) * 1000).toISOString();
    const lines = [
        JSON.stringify({type: 'user', timestamp: iso(ageSec), message: {content: prompt}}),
        JSON.stringify({type: 'assistant', timestamp: iso(ageSec), message: {
            id: 'a1', model: 'claude-opus',
            usage: {input_tokens: 10, output_tokens: 20,
                cache_creation: {ephemeral_1h_input_tokens: 5000}, cache_read_input_tokens: 1000},
        }}),
    ];
    if (trailingSystem) lines.push(JSON.stringify({type: 'system', timestamp: iso(1), message: {}}));
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
}

test('cache countdown anchors to the last real cache write, not the transcript mtime', () => {
    // 1h cache written 2h ago, then a fresh system row bumps mtime to "now".
    // The cache is dead; keying off mtime would wrongly show a full hour left.
    const expired = render(status({
        transcript_path: writeTranscript({ageSec: 7200, trailingSystem: true}),
        context_window: {context_window_size: 200000, current_usage: {input_tokens: 12000}},
    }));
    assert.match(expired, /❄now/, expired);

    // A live cache written 20 min ago should still count down (~40m left).
    const live = render(status({
        transcript_path: writeTranscript({ageSec: 1200, trailingSystem: false}),
        context_window: {context_window_size: 200000, current_usage: {input_tokens: 12000}},
    }));
    assert.match(live, /❄\d+m/, live);
    assert.ok(!/❄now/.test(live), live);
});

test('cache countdown survives a session with no plain-text user prompt', () => {
    // A session driven entirely by wrapped rows: the last-user-prompt field comes out
    // empty, and without a non-collapsing sentinel `read` would shift the cache epoch
    // into it and re-anchor the countdown to the transcript mtime ("now").
    const line = render(status({
        transcript_path: writeTranscript({
            ageSec: 7200, trailingSystem: true, prompt: '<local-command-stdout></local-command-stdout>',
        }),
        context_window: {context_window_size: 200000, current_usage: {input_tokens: 12000}},
    }));
    assert.match(line, /❄now/, line);
});

test('a slash-command turn counts as a real user prompt (Δ resets)', () => {
    // <command-message> is the user typing; only the surrounding plumbing is harness noise.
    const line = render(status({
        transcript_path: writeTranscript({
            ageSec: 60, prompt: '<command-message>checkup</command-message><command-name>/checkup</command-name>',
        }),
        context_window: {context_window_size: 200000, current_usage: {input_tokens: 12000}},
    }));
    // The lone assistant turn predates nothing, so Δ carries it; what matters is that
    // the prompt was recognised — the countdown stays anchored to the cache write.
    assert.match(line, /❄\d+m/, line);
});

test('statusline malformed stdin still produces a line (no crash)', () => {
    const {stdout, status: code} = spawnSync('bash', [SCRIPT], {input: 'not json', encoding: 'utf8'});
    assert.equal(code, 0);
    assert.ok((stdout ?? '').length > 0);
});
