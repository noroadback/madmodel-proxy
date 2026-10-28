'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');
const { TOKEN_FILE, CREDS_FILE } = require('../platform/paths');

// 在所有平台检查实际传给 security 的 argv；真实钥匙串行为由平台冒烟覆盖。
function fixture(initial = {}) {
  const items = new Map(Object.entries(initial));
  const calls = [];
  let failAccount = null;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => {
    assert.equal(file, 'security');
    assert.equal(args[args.indexOf('-s') + 1], process.env.MADMODEL_KEYCHAIN_SERVICE);
    calls.push(args.slice());
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'add-generic-password') {
      if (account === failAccount || (items.has(account) && args.includes('-T'))) {
        throw Object.assign(new Error('keychain update failed'), {
          stderr: Buffer.from('SecKeychainItemSetAccess: In dark wake, no UI possible'),
        });
      }
      items.set(account, args[args.indexOf('-w') + 1]);
      return Buffer.alloc(0);
    }
    assert.equal(args[0], 'find-generic-password');
    if (!items.has(account)) throw Object.assign(new Error('missing'), { status: 44 });
    return Buffer.from(items.get(account) + '\n');
  };
  let credentials;
  try {
    delete require.cache[require.resolve('../platform/macos/credentials')];
    credentials = require('../platform/macos/credentials');
  } finally {
    childProcess.execFileSync = original;
  }
  return { credentials, calls, items, fail(account) { failAccount = account; } };
}

function checkWrites(calls, accounts) {
  const writes = calls.filter(args => args[0] === 'add-generic-password');
  assert.deepEqual(writes.map(args => args[args.indexOf('-a') + 1]), accounts);
  for (const args of writes) {
    assert.ok(args.includes('-U'), '保留更新已有条目的语义');
    assert.ok(!args.includes('-T'), '写入不应修改访问控制');
    assert.ok(!args.includes('-A'), '不能允许所有应用访问');
  }
}

test('macOS 新建密码、token 和 cookie 不显式设置 ACL，非 ASCII 可读回', () => {
  const { credentials: c, calls } = fixture();
  c.writeAccount('synthetic-user', '密码-"\\-Φ', 'synthetic-fingerprint');
  c.writeToken('token-令牌', 1234, 'cookie-会话');
  assert.equal(c.readAccount().password, '密码-"\\-Φ');
  assert.deepEqual(c.readToken(), { token: 'token-令牌', expiresAt: 1234, cookie: 'cookie-会话' });
  checkWrites(calls, ['password', 'token', 'webvpn-cookie']);
});

test('macOS 既有条目可连续更新，不请求修改 ACL', () => {
  const initial = Object.fromEntries(['password', 'token', 'webvpn-cookie']
    .map(account => [account, Buffer.from('legacy-' + account).toString('base64')]));
  const { credentials: c, calls } = fixture(initial);
  for (let i = 1; i <= 2; i++) {
    c.writeAccount('synthetic-user', 'new-password-' + i, 'synthetic-fingerprint');
    c.writeToken('new-token-' + i, i, 'new-cookie-' + i);
    assert.equal(c.readAccount().password, 'new-password-' + i);
    assert.deepEqual(c.readToken(), { token: 'new-token-' + i, expiresAt: i, cookie: 'new-cookie-' + i });
  }
  checkWrites(calls, ['password', 'token', 'webvpn-cookie', 'password', 'token', 'webvpn-cookie']);
});

test('macOS 更新 token 未提供 cookie 时保留既有 cookie', () => {
  const { credentials: c, calls } = fixture();
  c.writeToken('old-token', 1, 'existing-cookie');
  calls.length = 0;
  c.writeToken('new-token', 2);
  assert.deepEqual(c.readToken(), { token: 'new-token', expiresAt: 2, cookie: 'existing-cookie' });
  checkWrites(calls, ['token']);
});

test('macOS 钥匙串写入报错时不提前更新元数据', () => {
  const { credentials: c, fail } = fixture();
  c.writeAccount('synthetic-user', 'old-password', 'synthetic-fingerprint');
  c.writeToken('old-token', 1, 'old-cookie');
  const tokenMeta = fs.readFileSync(TOKEN_FILE, 'utf8');
  const accountMeta = fs.readFileSync(CREDS_FILE, 'utf8');
  fail('webvpn-cookie');
  assert.throws(() => c.writeToken('new-token', 2, 'new-cookie'), /钥匙串写入失败/);
  assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8'), tokenMeta);
  fail('password');
  assert.throws(() => c.writeAccount('new-user', 'new-password', 'new-fingerprint'), /钥匙串写入失败/);
  assert.equal(fs.readFileSync(CREDS_FILE, 'utf8'), accountMeta);
});
