// Minimal tests for statusline-command.sh. The script reads a Claude Code status JSON
// object on stdin and prints one status line on stdout (with ANSI color codes). Each
// case feeds a hand-built input and asserts on the rendered, color-stripped line.
// Requires bash and jq on PATH — the same dependencies the status line itself needs.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'statusline-command.sh');

// Run the script with a JSON status object and return its output with ANSI codes stripped.
function render(status) {
    const {stdout} = spawnSync('bash', [SCRIPT], {input: JSON.stringify(status), encoding: 'utf8'});
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
            five_hour: {used_percentage: 16, resets_at: now + 7200},
            seven_day: {used_percentage: 2, resets_at: now + 3 * 86400},
        },
    }));
    assert.match(line, /5h:16% ↺2h \| 7d:2% ↺3d/);
});

test('statusline session cost uses total_cost_usd when present', () => {
    const line = render(status({cost: {total_cost_usd: 14.9}}));
    assert.ok(line.includes('Σ$14.90'), line);
});

test('statusline malformed stdin still produces a line (no crash)', () => {
    const {stdout, status: code} = spawnSync('bash', [SCRIPT], {input: 'not json', encoding: 'utf8'});
    assert.equal(code, 0);
    assert.ok((stdout ?? '').length > 0);
});
