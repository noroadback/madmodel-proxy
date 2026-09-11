// test/update-check.test.js — 版本比较纯函数 + 注入 fetch 的检查器。
// 比较语义是提示的触发条件,数值边界(1.10.0 > 1.9.0)与畸形输入必须钉死
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isNewerVersion, checkForUpdate } = require('../core/update-check');

// ---- isNewerVersion ----
test('版本比较: 相等不算新', () => {
  assert.strictEqual(isNewerVersion('1.7.2', 'v1.7.2'), false);
  assert.strictEqual(isNewerVersion('1.7.2', '1.7.2'), false);
});

test('版本比较: 高版本算新,v 前缀与无前缀等价', () => {
  assert.strictEqual(isNewerVersion('1.7.2', 'v1.7.3'), true);
  assert.strictEqual(isNewerVersion('1.7.2', '1.8.0'), true);
  assert.strictEqual(isNewerVersion('1.7.2', 'v2.0.0'), true);
});

test('版本比较: 低版本不算新', () => {
  assert.strictEqual(isNewerVersion('1.8.0', 'v1.7.2'), false);
  assert.strictEqual(isNewerVersion('2.0.0', 'v1.99.99'), false);
});

test('版本比较: 数值比较而非字符串(1.10.0 > 1.9.0)', () => {
  assert.strictEqual(isNewerVersion('1.9.0', 'v1.10.0'), true);
  assert.strictEqual(isNewerVersion('1.10.0', 'v1.9.0'), false);
});

test('版本比较: 畸形输入一律不算新(宁可漏报不误报)', () => {
  assert.strictEqual(isNewerVersion('1.7.2', ''), false);
  assert.strictEqual(isNewerVersion('1.7.2', 'latest'), false);
  assert.strictEqual(isNewerVersion('1.7.2', 'v1.7'), false);
  assert.strictEqual(isNewerVersion('1.7.2', 'v1.7.x'), false);
  assert.strictEqual(isNewerVersion('', 'v1.8.0'), false);
  assert.strictEqual(isNewerVersion(undefined, 'v1.8.0'), false);
});

// ---- checkForUpdate(注入 fetch,离线) ----
const res = body => ({ ok: true, json: async () => body });

test('检查器: 最新 release 比本地新 → 返回 update', async () => {
  const r = await checkForUpdate('a/b', '1.7.2', {
    fetchImpl: async () => res({ tag_name: 'v1.8.0' }),
  });
  assert.deepStrictEqual(r, { update: 'v1.8.0' });
});

test('检查器: 与本地相同 → latest', async () => {
  const r = await checkForUpdate('a/b', '1.8.0', {
    fetchImpl: async () => res({ tag_name: 'v1.8.0' }),
  });
  assert.strictEqual(r, 'latest');
});

test('检查器: 比本地旧(回滚场景) → latest,不提示降级', async () => {
  const r = await checkForUpdate('a/b', '1.9.0', {
    fetchImpl: async () => res({ tag_name: 'v1.8.0' }),
  });
  assert.strictEqual(r, 'latest');
});

test('检查器: HTTP 非 2xx(限流 403/无 release 404) → null 静默', async () => {
  for (const status of [403, 404, 500]) {
    const r = await checkForUpdate('a/b', '1.7.2', {
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
    });
    assert.strictEqual(r, null, String(status));
  }
});

test('检查器: 网络错误/超时/响应畸形 → null 静默', async () => {
  const boom = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
  assert.strictEqual(await checkForUpdate('a/b', '1.7.2', { fetchImpl: async () => { throw boom; } }), null);
  assert.strictEqual(await checkForUpdate('a/b', '1.7.2', {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
  }), null);
  assert.strictEqual(await checkForUpdate('a/b', '1.7.2', {
    fetchImpl: async () => res({}), // 无 tag_name
  }), null);
});
