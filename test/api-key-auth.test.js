// test/api-key-auth.test.js — API Key 鉴权与对外监听形态。
// 覆盖两层:(1) 纯函数 extractApiKey/apiKeyAccepted 的提取与时间恒定比较;
// (2) 端到端 —— 配置 apiKeys 后,无/错 key 被 401,正确 key 放行到业务层;
// 对外监听(0.0.0.0)时外部 Host 头不再被白名单 403(边界改由鉴权承担)。
// config 在 require 时读 process.env,测试用环境变量 + 清缓存重载。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MADMODEL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-auth-'));
const { extractApiKey, apiKeyAccepted, createHttpServer } = require('../adapters/http-server');

// ---- 纯函数层 ----
test('extractApiKey: Bearer 优先,回退 x-api-key,缺失为空', () => {
  assert.strictEqual(extractApiKey({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.strictEqual(extractApiKey({ headers: { authorization: 'bearer Tok' } }), 'Tok'); // 大小写不敏感
  assert.strictEqual(extractApiKey({ headers: { 'x-api-key': 'xyz' } }), 'xyz');
  assert.strictEqual(extractApiKey({ headers: {} }), '');
});

test('apiKeyAccepted: 命中任一 key 通过,错/空/长度不等一律拒', () => {
  const keys = ['key-one', 'key-two'];
  assert.strictEqual(apiKeyAccepted('key-one', keys), true);
  assert.strictEqual(apiKeyAccepted('key-two', keys), true);
  assert.strictEqual(apiKeyAccepted('key-three', keys), false);
  assert.strictEqual(apiKeyAccepted('', keys), false);
  assert.strictEqual(apiKeyAccepted('key', keys), false); // 长度不等不得抛
  assert.strictEqual(apiKeyAccepted('key-one', []), false); // 无配置 key 时任何都不过
});

// ---- 端到端层 ----
// 造一个最小 service 桩(只需 logReq;鉴权早退不会走到 handleRequest)
function stubService() {
  const calls = [];
  return {
    logReq: (req, code, started, size, note) => calls.push({ code, note }),
    handleRequest: ctx => { ctx.sendJson(200, { ok: true, reached: 'service' }); },
    calls,
  };
}

function startServer(cfgOverride) {
  const config = {
    port: 0, host: '127.0.0.1', models: ['M'], contextWindow: 100, maxModelTokens: 10,
    maxConnections: 8, apiKeys: [], bodyLimit: 1024, bodyTimeout: 1000,
    ...cfgOverride,
  };
  const service = stubService();
  const { server } = createHttpServer({ config, service, getToken: () => null });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, service, port: server.address().port }));
  });
}

function req(port, pathname, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    if (method === 'POST') r.end('{}'); else r.end();
  });
}

test('未配置 apiKeys:不鉴权,GET /v1/models 直接 200(原行为不变)', async () => {
  const { server, port } = await startServer({ apiKeys: [] });
  const r = await req(port, '/v1/models', { host: "127.0.0.1" });
  assert.strictEqual(r.status, 200);
  server.close();
});

test('配置 apiKeys:缺 key → 401,错 key → 401,对 key → 放行', async () => {
  const { server, port } = await startServer({ apiKeys: ['secret-key'] });
  const noKey = await req(port, '/v1/models', { host: "127.0.0.1" });
  assert.strictEqual(noKey.status, 401);
  const badKey = await req(port, '/v1/models', { host: "127.0.0.1", authorization: 'Bearer wrong' });
  assert.strictEqual(badKey.status, 401);
  const goodKey = await req(port, '/v1/models', { host: "127.0.0.1", authorization: 'Bearer secret-key' });
  assert.strictEqual(goodKey.status, 200);
  const viaXKey = await req(port, '/v1/models', { host: "127.0.0.1", 'x-api-key': 'secret-key' });
  assert.strictEqual(viaXKey.status, 200);
  server.close();
});

test('/healthz 免鉴权、免白名单', async () => {
  const { server, port } = await startServer({ apiKeys: ['k'] });
  const r = await req(port, '/healthz', { host: 'anything-else' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, 'ok');
  server.close();
});

test('对外监听(host=0.0.0.0)+已鉴权:外部 Host 头不被白名单 403,带 key 放行', async () => {
  // 监听仍绑 127.0.0.1(测试可达),但 config.host 设 0.0.0.0 模拟对外形态
  const { server, port } = await startServer({ host: '0.0.0.0', apiKeys: ['k'] });
  // 外部 IP 风格的 Host 头(不在回环白名单)——对外形态下应放行到鉴权
  const withKey = await req(port, '/v1/models', { host: '10.103.10.88:8080', authorization: 'Bearer k' });
  assert.strictEqual(withKey.status, 200); // 未被 host-rejected
  const noKey = await req(port, '/v1/models', { host: '10.103.10.88:8080' });
  assert.strictEqual(noKey.status, 401); // 边界由鉴权承担
  server.close();
});

test('回环监听(默认)仍强制 Host 白名单', async () => {
  const { server, port } = await startServer({ host: '127.0.0.1', apiKeys: [] });
  const r = await req(port, '/v1/models', { host: 'evil.example.com' });
  assert.strictEqual(r.status, 403);
  server.close();
});
