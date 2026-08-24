import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecFileException } from 'node:child_process';
import {
  terminateUtilityProcessTree,
  type KillableUtilityProcess,
  type ProcessTreeExecFile,
} from '../src/runtime-manager.js';

function fakeChild(pid = 4312): KillableUtilityProcess & { killCalls: number } {
  return {
    pid,
    killCalls: 0,
    kill() {
      this.killCalls += 1;
      return true;
    },
  };
}

test('Windows forced shutdown uses taskkill.exe with a fixed process-tree argument list', async () => {
  const child = fakeChild();
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const runExecFile: ProcessTreeExecFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null);
  };

  const result = await terminateUtilityProcessTree(child, {
    platform: 'win32',
    execFile: runExecFile,
  });

  assert.equal(result, 'taskkill');
  assert.deepEqual(calls, [{
    file: 'taskkill.exe',
    args: ['/PID', '4312', '/T', '/F'],
    options: { shell: false, timeout: 5_000, windowsHide: true },
  }]);
  assert.equal(child.killCalls, 0);
});

test('Windows forced shutdown falls back to child.kill when taskkill fails', async () => {
  const child = fakeChild(9876);
  const runExecFile: ProcessTreeExecFile = (_file, _args, _options, callback) => {
    callback(Object.assign(new Error('taskkill unavailable'), { code: 'ENOENT' }) as ExecFileException);
  };

  const result = await terminateUtilityProcessTree(child, {
    platform: 'win32',
    execFile: runExecFile,
  });

  assert.equal(result, 'child-kill');
  assert.equal(child.killCalls, 1);
});

test('non-Windows forced shutdown skips taskkill and uses child.kill', async () => {
  const child = fakeChild();
  let execCalls = 0;
  const runExecFile: ProcessTreeExecFile = () => {
    execCalls += 1;
  };

  const result = await terminateUtilityProcessTree(child, {
    platform: 'linux',
    execFile: runExecFile,
  });

  assert.equal(result, 'child-kill');
  assert.equal(execCalls, 0);
  assert.equal(child.killCalls, 1);
});

test('fallback remains safe when child already exited', async () => {
  const child: KillableUtilityProcess = {
    pid: undefined,
    kill() {
      throw new Error('already exited');
    },
  };

  const result = await terminateUtilityProcessTree(child, { platform: 'win32' });
  assert.equal(result, 'failed');
});
