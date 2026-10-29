import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows update script handles safe startup and failure scenarios', (context) => {
  if (process.platform !== 'win32') {
    context.skip('requires Windows PowerShell');
    return;
  }
  const harness = fileURLToPath(new URL('./update-and-restart.test.ps1', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/update-and-restart.ps1', import.meta.url));
  for (const scenario of ['success', 'dirty', 'hidden-changes', 'wrong-task', 'missing-task', 'diverged', 'build-fails']) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
      '-Script', script, '-Scenario', scenario,
    ], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.error, undefined, `${scenario}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${scenario}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`PASS ${scenario}`));
  }
});
