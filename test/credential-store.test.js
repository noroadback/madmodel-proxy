// test/credential-store.test.js — 文件型凭据存储的 cookie 字段往返。
// protect/unprotect 由测试注入(纯字符串变换),经 MADMODEL_STATE_DIR 重定向
// 到临时目录,离线验证 cipherCookie 写读联与旧记录向后兼容。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require credential-store 之前重定向:TOKEN_FILE 在模块加载时解析
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-'));
process.env.MADMODEL_STATE_DIR = stateDir;
const TOKEN_FILE = path.join(stateDir, 'token.json');
const createFileCredentialStore = require('../platform/credential-store');

// 注入的加密原语:可逆、可识别,模拟 DPAPI/AES-GCM,不触碰真实平台
const store = createFileCredentialStore({
  protect: s => 'cipher:' + Buffer.from(s).toString('base64'),
  unprotect: s => {
    if (!s.startsWith('cipher:')) return null;
    return Buffer.from(s.slice('cipher:'.length), 'base64').toString('utf8');
  },
});

test('带 cookie 写入:token 与 cookie 都加密入库,读取可往返还原', () => {
  store.writeToken('tok-1', 1234, 'wengine_vpn_ticket=xyz; foo=bar');
  const rec = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  assert.strictEqual(typeof rec.cipher, 'string');
  assert.strictEqual(typeof rec.cipherCookie, 'string');
  assert.ok(!JSON.stringify(rec).includes('tok-1'));   // 明文不得落盘
  assert.ok(!JSON.stringify(rec).includes('wengine_vpn_ticket'));
  const read = store.readToken();
  assert.deepStrictEqual(read, { token: 'tok-1', expiresAt: 1234, cookie: 'wengine_vpn_ticket=xyz; foo=bar' });
});

test('不带 cookie 写入(readToken 返回 cookie 为空时):不再写新 cookie 字段', () => {
  store.writeToken('tok-2', 5678);
  const rec = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  assert.ok(!('cipherCookie' in rec));   // 字段不写
  const read = store.readToken();
  assert.deepStrictEqual(read, { token: 'tok-2', expiresAt: 5678 });  // cookie 缺省
});

test('旧格式记录(无 cipherCookie):读侧 cookie 缺省,不报错', () => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ v: 1, cipher: 'cipher:dG9rLW9sZA==', expiresAt: 999, updatedAt: 'x' }));
  const read = store.readToken();
  assert.deepStrictEqual(read, { token: 'tok-old', expiresAt: 999 });
});

test('带 cookie 记录 + 不带 cookie 重写:不残留上次的 cookie', () => {
  store.writeToken('tok-3', 111, 'old-cookie-value');
  store.writeToken('tok-3b', 222);   // 无 cookie
  const read = store.readToken();
  assert.deepStrictEqual(read, { token: 'tok-3b', expiresAt: 222 });
  assert.strictEqual(read.cookie, undefined);
});

test('坏记录/解不开:按"无数据"返回 null,不抛', () => {
  fs.writeFileSync(TOKEN_FILE, 'not json');
  assert.strictEqual(store.readToken(), null);
  // 模拟真实平台"解密抛错"(DPAPI/AES-GCM 解不开即 throw),tryUnprotect 须降级
  const throwingStore = createFileCredentialStore({
    protect: x => x,
    unprotect: () => { throw new Error('decrypt failed'); },
  });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ v: 1, cipher: 'garbage', expiresAt: 1 }));
  assert.strictEqual(throwingStore.readToken(), null);
});