// Run with: node test/gui-cli-collision.mjs <built desktop executable>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.argv[2];
assert.ok(executable, 'Pass the path to the built GUI executable');
const sandbox = mkdtempSync(join(tmpdir(), 'multicodexstate-gui-'));
try {
  for (const command of ['list', 'usage']) {
    // If the old GUI opens, its automatic refresh gets a harmless CLI in an
    // empty directory and cannot launch another GUI or read live accounts.
    const result = spawnSync(resolve(executable), [command, '--json'], {
      cwd: sandbox,
      env: { ...process.env, MULTICODEXSTATE_CLI: process.execPath, CODEX_HOME: sandbox },
      timeout: 5000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /MULTICODEXSTATE_CLI/);
    console.log(`PASS: GUI rejected ${command} --json before opening a window`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
