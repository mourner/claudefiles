// Data-driven test suite for guard.mjs. Most cases call the exported decide() core directly in this
// process (no per-case node spawn → the whole suite runs in well under a second). A couple of spawn
// cases at the end exercise the CLI wrapper itself: the stdin→stdout JSON contract a PreToolUse hook
// actually uses, and the malformed-stdin fail-open path that only the wrapper has.
//
// Each case in cases.json is {name, tool_name, tool_input, expect: "allow"|"deny", denyMatch?, env?}.
// decide() returns the deny reason string, or null to allow. Cases reference fixture files
// (foo.json, big.ts, src/, …) created in a temp dir; the test chdir's into it so the guard's
// existsSync/statSync checks resolve against the fixtures.

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
    // Small existing files of gated/extra extensions.
    writeFileSync(join(fixtures, 'foo.json'), '{"x":1}\n');
    writeFileSync(join(fixtures, 'foo.ts'), 'export const x = 1;\n');
    writeFileSync(join(fixtures, 'foo.py'), 'x = 1\n');
    // Files larger than the 16 KB gate.
    const big = 'x'.repeat(20 * 1024);
    writeFileSync(join(fixtures, 'big.ts'), big);
    writeFileSync(join(fixtures, 'big.md'), big);
    // An existing directory for the scoped-grep case.
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
        const reason = decide({tool_name: c.tool_name, tool_input: c.tool_input}, {...process.env, ...(c.env ?? {})});
        if (c.expect === 'deny') {
            assert.ok(reason != null, 'expected a deny, got allow');
            if (c.denyMatch) assert.ok(reason.includes(c.denyMatch), `deny reason missing "${c.denyMatch}": ${reason}`);
        } else {
            assert.equal(reason, null, `expected an allow, got a deny: ${reason}`);
        }
    });
}

// ── CLI wrapper contract (spawned) ───────────────────────────────────────────────────────────────

function runCli(stdin, env) {
    return spawnSync('node', [GUARD], {input: stdin, cwd: fixtures, env: {...process.env, ...env}, encoding: 'utf8'}).stdout ?? '';
}

test('CLI: a deny writes the hook decision JSON to stdout', () => {
    const out = runCli(JSON.stringify({tool_name: 'Bash', tool_input: {command: 'cat foo.json'}}), {});
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /Read tool/);
});

test('CLI: an allow writes nothing', () => {
    const out = runCli(JSON.stringify({tool_name: 'Bash', tool_input: {command: 'ls'}}), {});
    assert.equal(out, '');
});

test('CLI: malformed JSON on stdin fails open (no output)', () => {
    const out = runCli('this is not json {', {});
    assert.equal(out, '');
});
