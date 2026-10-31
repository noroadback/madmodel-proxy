'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { once } = require('events');
const { acquirePidLock, releasePidLock } = require('../platform/process-lock');
const { readLockOwner, sameProcess } = require('../platform/process-lock');
const { processIdentities, parseLinuxStat } = require('../platform/process-identity');
const { createTestEnv } = require('../scripts/isolated-env');

const dir = process.env.MADMODEL_STATE_DIR;
const workerPath = path.join(dir, 'lock-worker.cjs');
fs.writeFileSync(workerPath, `
  const lock = require(${JSON.stringify(require.resolve('../platform/process-lock'))});
  process.on('message', async ({ command, file }) => {
    try {
      if (command === 'release') {
        lock.releasePidLock(file);
        process.send({ released: true });
      } else process.send(await lock.acquirePidLock(file));
    } catch (e) { process.send({ error: e.message }); }
  });
  process.send({ ready: true });
`);

async function worker(t) {
  const child = fork(workerPath, [], { env: createTestEnv(dir), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  });
  await once(child, 'message');
  return child;
}
async function ask(child, command, file) {
  const reply = once(child, 'message');
  child.send({ command, file });
  const [value] = await reply;
  assert.equal(value.error, undefined);
  return value;
}

// Windows 创建时间查询要启动系统 PowerShell；为 8×8 轮争用留出 CI 调度余量。
test('八个进程争用旧锁，任一轮只能有一个持有者', { timeout: 90000 }, async t => {
  const workers = await Promise.all(Array.from({ length: 8 }, () => worker(t)));
  const file = path.join(dir, 'contended.lock');
  fs.writeFileSync(file, 'invalid-stale-pid');
  for (let round = 0; round < 8; round++) {
    const result = await Promise.all(workers.map(child => ask(child, 'acquire', file)));
    assert.equal(result.filter(r => r.ok).length, 1, `第 ${round + 1} 轮必须恰有一个持有者`);
    const winner = workers[result.findIndex(r => r.ok)];
    assert.equal(Number(fs.readFileSync(file, 'utf8')), winner.pid);
    const stillHeld = await Promise.all(workers.map(child => ask(child, 'acquire', file)));
    assert.ok(stillHeld.every(r => !r.ok), '其他进程与持有者自身都不能再次取得同一锁');
    await ask(winner, 'release', file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(`${file}.holders`).length, 0);
  }
});

test('持锁进程被强制结束后，下一进程可恢复且不清理存活记录', { timeout: 10000 }, async t => {
  const child = await worker(t);
  const file = path.join(dir, 'crashed.lock');
  assert.equal((await ask(child, 'acquire', file)).ok, true);
  assert.equal((await acquirePidLock(file)).ok, false);
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  // 模拟同一死亡进程在出票阶段崩溃的另一条残留。
  fs.writeFileSync(path.join(`${file}.holders`, `${child.pid}.aaaa.json`), JSON.stringify({ choosing: true, ticket: 0 }));
  assert.equal((await acquirePidLock(file)).ok, true);
  assert.equal(fs.readdirSync(`${file}.holders`).length, 1);
  releasePidLock(file);
  assert.equal(fs.readdirSync(`${file}.holders`).length, 0);
});

test('旧版存活 PID 阻止获取；他方 release 不能删除持有者锁', { timeout: 10000 }, async t => {
  const child = await worker(t);
  const file = path.join(dir, 'legacy.lock');
  fs.writeFileSync(file, String(child.pid));
  assert.deepEqual(await acquirePidLock(file), { ok: false, pid: child.pid });
  releasePidLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), String(child.pid));
});

test('PID 被复用时清理旧身份的 PID 文件和 holder，保留当前真实进程', { timeout: 15000 }, async t => {
  const child = await worker(t);
  const actual = processIdentities([child.pid]).get(child.pid);
  assert.ok(actual, '当前平台必须能读取测试子进程创建时间');
  const file = path.join(dir, 'reused.lock'), holders = `${file}.holders`;
  fs.mkdirSync(holders);
  fs.writeFileSync(file, String(child.pid));
  fs.writeFileSync(`${file}.identity.json`, JSON.stringify({ pid: child.pid, identity: `${actual}-old` }));
  fs.writeFileSync(path.join(holders, `${child.pid}.aaaa.json`),
    JSON.stringify({ choosing: false, ticket: 1, identity: `${actual}-old` }));
  assert.equal(readLockOwner(file).alive, false);
  assert.equal((await acquirePidLock(file)).ok, true);
  const owner = readLockOwner(file);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.alive, true);
  assert.equal(fs.readdirSync(holders).length, 1);
  fs.unlinkSync(file);
  assert.equal(readLockOwner(file).alive, true, '兼容 PID 文件缺失时 holder 仍阻止 logout/双跑');
  fs.writeFileSync(file, String(process.pid));
  releasePidLock(file);
  assert.equal(fs.existsSync(`${file}.identity.json`), false);
  assert.equal(process.kill(child.pid, 0), true, '接管锁不杀死复用 PID 的无关进程');
});

test('无法读取身份或 EPERM 不构成死亡证据；Linux stat 的括号名称可解析', t => {
  assert.equal(sameProcess(process.pid, 'known-old', new Map()), true);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(sameProcess(12345, null), true);
  assert.equal(sameProcess(12345, 'known', new Map()), true);
  const fields = ['S', ...Array(18).fill('0'), '987654', '0'];
  assert.equal(parseLinuxStat(`123 (worker (name)) ${fields.join(' ')}`, 'boot-id\n'), 'linux:boot-id:987654');
});
