// test/config-keepalive.test.js — config 的保活探测地址推导与隧道形态判定:
// 仅 madmodel 的 WebVPN 隧道前缀启用(直连域的 3xx 会被 classifyProbeStatus
// 误判为 invalid 而触发无谓续期,故不得启用保活);隧道前缀从 madmodel-auth
// 导出单一来源,tunnelMode 与 keepaliveUrl 共用同一判定。
// config 在 require 时读取 process.env,测试用 PROXY_UPSTREAM + 清缓存重载。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// paths 在 require 时可能执行真实状态目录迁移,重定向隔离避免副作用
process.env.MADMODEL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-'));
const CONFIG = require.resolve('../config');
const { MADMODEL_VPN_PREFIX } = require('../madmodel-auth');

const TUNNEL_DEFAULT = `${MADMODEL_VPN_PREFIX}/v1/chat/completions`;

// 用指定的 PROXY_UPSTREAM 重载 config,返回冻结配置对象,随后还原环境变量
function loadConfig(upstream) {
  const prev = process.env.PROXY_UPSTREAM;
  if (upstream === undefined) delete process.env.PROXY_UPSTREAM;
  else process.env.PROXY_UPSTREAM = upstream;
  delete require.cache[CONFIG];
  try {
    return require('../config');
  } finally {
    if (prev === undefined) delete process.env.PROXY_UPSTREAM;
    else process.env.PROXY_UPSTREAM = prev;
    delete require.cache[CONFIG];
  }
}

test('默认上游(未设 PROXY_UPSTREAM)为隧道形态:保活派生 + tunnelMode 开', () => {
  const cfg = loadConfig(undefined);
  assert.strictEqual(cfg.upstream, TUNNEL_DEFAULT);
  assert.strictEqual(cfg.keepaliveUrl, TUNNEL_DEFAULT.replace('/v1/chat/completions', '/v1/models'));
  assert.strictEqual(cfg.tunnelMode, true);
});

test('PROXY_UPSTREAM 覆盖为校内直连域名:保活禁用,tunnelMode 关(cookie 不回传直连域)', () => {
  const cfg = loadConfig('https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions');
  assert.strictEqual(cfg.keepaliveUrl, null);
  assert.strictEqual(cfg.tunnelMode, false);
  assert.strictEqual(cfg.upstream, 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions');
});

test('PROXY_UPSTREAM 指向测试假上游(非隧道域名):保活禁用,tunnelMode 关', () => {
  const cfg = loadConfig('http://127.0.0.1:9999/v1/chat/completions');
  assert.strictEqual(cfg.keepaliveUrl, null);
  assert.strictEqual(cfg.tunnelMode, false);
});

test('PROXY_UPSTREAM 指向 webvpn 域但非 madmodel 隧道前缀:一律禁用', () => {
  // 隧道域名但路径形态不对
  const a = loadConfig('https://webvpn.tsinghua.edu.cn/some/other/path');
  assert.strictEqual(a.keepaliveUrl, null);
  // 隧道前缀形态标准但编码的是别的应用(非 madmodel 的 hash)
  const b = loadConfig('https://webvpn.tsinghua.edu.cn/https/abc/v1/chat/completions');
  assert.strictEqual(b.keepaliveUrl, null);
  assert.strictEqual(b.tunnelMode, false);
});
