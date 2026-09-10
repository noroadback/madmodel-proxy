// test/config-keepalive.test.js — config 的保活探测地址推导:
// 仅 WebVPN 隧道形态启用,校内直连覆盖 / 测试假上游一律禁用(直连域的 3xx
// 会被 classifyProbeStatus 误判为 invalid 而触发无谓续期,故不得启用保活)。
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

const TUNNEL_DEFAULT =
  'https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421fdf6459128346d5c300b9ae28c462a3b27469fc32211fa26a3e464/v1/chat/completions';

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

test('默认上游(未设 PROXY_UPSTREAM)为隧道形态,推导出同前缀 /v1/models 保活地址', () => {
  const cfg = loadConfig(undefined);
  assert.strictEqual(cfg.upstream, TUNNEL_DEFAULT);
  assert.strictEqual(cfg.keepaliveUrl, TUNNEL_DEFAULT.replace('/v1/chat/completions', '/v1/models'));
});

test('PROXY_UPSTREAM 覆盖为校内直连域名:保活整体禁用(keepaliveUrl 为 null)', () => {
  const cfg = loadConfig('https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions');
  assert.strictEqual(cfg.keepaliveUrl, null);
  assert.strictEqual(cfg.upstream, 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions');
});

test('PROXY_UPSTREAM 指向测试假上游(非隧道域名):保活禁用', () => {
  const cfg = loadConfig('http://127.0.0.1:9999/v1/chat/completions');
  assert.strictEqual(cfg.keepaliveUrl, null);
});

test('PROXY_UPSTREAM 指向隧道域名但非 /v1/chat/completions 形态:保活禁用', () => {
  const cfg = loadConfig('https://webvpn.tsinghua.edu.cn/some/other/path');
  assert.strictEqual(cfg.keepaliveUrl, null);
});

test('PROXY_UPSTREAM 指向隧道前缀的标准形态:启用保活并正确派生', () => {
  const cfg = loadConfig('https://webvpn.tsinghua.edu.cn/https/abc/v1/chat/completions');
  assert.strictEqual(cfg.keepaliveUrl, 'https://webvpn.tsinghua.edu.cn/https/abc/v1/models');
});