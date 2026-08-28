// Data-driven test suite for guard.mjs. Most cases call the exported decide() core directly in this
// process (no per-case node spawn → the whole suite runs in well under a second). A couple of spawn
// cases at the end exercise the CLI wrapper itself: the stdin→stdout JSON contract a PreToolUse hook
// actually uses, and the malformed-stdin fail-open path that only the wrapper has.
//
// Each case in cases.json is {name, tool_name, tool_input, expect: "allow"|"deny", denyMatch?}.
// decide() returns the deny reason string, or null to allow. Cases reference fixture files
// (foo.json, big.ts, huge.json, src/, …) created in a temp dir; the test chdir's into it so the
// guard's statSync checks resolve against the fixtures.
//
// Many cases assert an *allow* on a shape an earlier version of the guard blocked (tree-wide grep,
// `find -exec cat`, `git show <ref>:<path>`, small-file `cat`). Those are not filler: bash-first
// auto mode asks for exactly these, so they are the regressions that would hurt most if a future
// rule crept back in.

import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decide} from '../guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, '..', 'guard.mjs');
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

let fixtures, cwd0;

before(() => {
    fixtures = mkdtempSync(join(tmpdir(), 'guard-test-'));
    // Small files — under the ceiling, so nothing should fire on them.
    writeFileSync(join(fixtures, 'foo.json'), '{"x":1}\n');
    writeFileSync(join(fixtures, 'notes.md'), '# notes\n');
    // Mid-size: comfortably over the *old* 16 KB gate and under the current one, so these pin the
    // relaxation — they must stay allowed.
    const mid = 'x'.repeat(20 * 1024);
    writeFileSync(join(fixtures, 'big.ts'), mid);
    writeFileSync(join(fixtures, 'big.md'), mid);
    // Over the 128 KB ceiling.
    const huge = 'x'.repeat(200 * 1024);
    writeFileSync(join(fixtures, 'huge.json'), huge);
    writeFileSync(join(fixtures, 'huge.md'), huge);
    // A directory, to check that `cat <dir>` isn't treated as a file.
    mkdirSync(join(fixtures, 'src'));
    // The guard resolves relative paths against the cwd; run from the fixture dir.
    cwd0 = process.cwd();
    process.chdir(fixtures);
});

after(() => {
    process.chdir(cwd0);
    rmSync(fixtures, {recursive: true, force: true});
});

for (const c of cases) {
    test(c.name, () => {
        const reason = decide({tool_name: c.tool_name, tool_input: c.tool_input});
        if (c.expect === 'deny') {
            assert.ok(reason != null, 'expected a deny, got allow');
            if (c.denyMatch) assert.ok(reason.includes(c.denyMatch), `deny reason missing "${c.denyMatch}": ${reason}`);
        } else {
            assert.equal(reason, null, `expected an allow, got a deny: ${reason}`);
        }
    });
}

// ── CLI wrapper contract (spawned) ───────────────────────────────────────────────────────────────

function runCli(stdin) {
    return spawnSync('node', [GUARD], {input: stdin, cwd: fixtures, encoding: 'utf8'}).stdout ?? '';
}

test('CLI: a deny writes the hook decision JSON to stdout', () => {
    const out = runCli(JSON.stringify({tool_name: 'Bash', tool_input: {command: 'cat huge.json'}}));
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /straight into context/);
});

test('CLI: an allow writes nothing', () => {
    const out = runCli(JSON.stringify({tool_name: 'Bash', tool_input: {command: 'ls'}}));
    assert.equal(out, '');
});

test('CLI: malformed JSON on stdin fails open (no output)', () => {
    const out = runCli('this is not json {');
    assert.equal(out, '');
});
