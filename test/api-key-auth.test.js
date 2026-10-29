'use strict';
const { isolate, createTestEnv } = require('../scripts/isolated-env');
isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../config');
const { createHttpServer } = require('../adapters/http-server');
const { createModelRegistry } = require('../core/model-registry');
const { isProxyRunning } = require('../core/proxy-status');
const { validateListenConfig, localBaseUrl } = require('../core/listen-config');

async function startServer(t, overrides = {}) {
  const cfg = { ...config, port: 0, ...overrides };
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  cfg.port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const calls = [];
  let tokenReads = 0;
  const service = {
    logReq: (req, code, started, size, note) => calls.push({ code, note }),
    handleRequest: async ctx => { calls.push('chat'); ctx.sendJson(200, { ok: true }); },
  };
  const modelRegistry = createModelRegistry(cfg);
  const models = ['DeepSeek-V4.1-Flash', 'qwen3.8-27b', 'DeepSeek-R1-W8A8'];
  modelRegistry.publish(models.map(id => ({ id, ok: true, meta: cfg.thinkingFallback[id] })));
  const { server } = createHttpServer({ config: cfg, service, modelRegistry,
    getToken: () => { tokenReads++; throw new Error('health must not read credentials'); } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(cfg.port, '127.0.0.1', resolve));
  return { port: server.address().port, calls, models, tokenReads: () => tokenReads };
}

function request(port, url = '/v1/models', headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: { Host: 'localhost', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('默认回环模式保留免鉴权、Host 和 Origin 边界', async t => {
  const { port } = await startServer(t);
  assert.equal((await request(port)).status, 200);
  for (const url of ['/v1/models', '/healthz', '/v1/chat/completions']) {
    assert.equal((await request(port, url, { Host: 'evil.example' })).status, 403);
    assert.equal((await request(port, url, { Origin: 'https://evil.example' })).status, 403);
  }
});

test('所有业务端点拒绝缺失、错误及仅放在查询参数里的密钥', async t => {
  const { port, calls } = await startServer(t, { host: '0.0.0.0', apiKeys: ['first-key', 'second-key'] });
  for (const url of ['/', '/v1', '/v1/', '/models', '/v1/models', '/chat/completions', '/v1/chat/completions']) {
    const method = url.includes('completions') ? 'POST' : 'GET';
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer f' },
      { authorization: 'Bearer first-key-extra' }, { authorization: 'Basic first-key', 'x-api-key': 'first-key' }]) {
      const res = await request(port, url, { Host: '192.0.2.10:8080', ...headers }, method);
      assert.equal(res.status, 401, url);
      assert.equal(res.body.error.type, 'authentication_error');
      assert.equal(res.headers['www-authenticate'], 'Bearer realm="madmodel"');
      assert.ok(!JSON.stringify(res).includes('first-key'));
    }
  }
  assert.equal((await request(port, '/v1/models?api_key=first-key')).status, 401);
  assert.ok(!calls.includes('chat'));
});

test('轮换密钥、两种请求头及多模型能力列表正常工作', async t => {
  const { port, models, calls } = await startServer(t, { host: '0.0.0.0', apiKeys: ['first-key', 'second-key'] });
  for (const headers of [{ authorization: 'Bearer first-key' }, { authorization: 'bearer second-key' },
    { 'x-api-key': 'second-key' }, { authorization: 'Bearer first-key', 'x-api-key': 'wrong' }]) {
    const res = await request(port, '/v1/models', { Host: '192.0.2.10:8080', ...headers });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map(m => m.id), models);
    assert.ok(res.body.data.every(m => m.available && m.reasoning.supported));
    assert.equal((await request(port, '/v1/chat/completions', headers, 'POST')).status, 200);
  }
  assert.equal(calls.filter(c => c === 'chat').length, 4);
});

test('回环加密钥时仍检查 Host 和 Origin', async t => {
  const { port } = await startServer(t, { apiKeys: ['key'] });
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, '/v1/models', { authorization: 'Bearer key' })).status, 200);
  assert.equal((await request(port, '/v1/models', { Host: 'evil.example', authorization: 'Bearer key' })).status, 403);
  assert.equal((await request(port, '/v1/models', { Origin: 'null', authorization: 'Bearer key' })).status, 403);
});

test('健康端点不读凭据，只返回身份；开启鉴权仍能探测运行状态', async t => {
  const { port, calls, tokenReads } = await startServer(t, { apiKeys: ['key'] });
  const res = await request(port, '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', proxy: 'madmodel' });
  assert.equal(await isProxyRunning(port), true);
  assert.equal(tokenReads(), 0);
  assert.deepEqual(calls, []);
});

test('运行检测兼容没有 healthz 的旧版，不跟随重定向', async () => {
  const seen = [];
  assert.equal(await isProxyRunning(12345, async (url, options) => {
    seen.push(url);
    assert.equal(options.redirect, 'error');
    return { status: url.endsWith('/healthz') ? 404 : 200, json: async () => ({ proxy: 'madmodel' }) };
  }), true);
  assert.deepEqual(seen, ['http://127.0.0.1:12345/healthz', 'http://127.0.0.1:12345/']);
});

test('通配、IPv6 和指定地址的探测 URL', () => {
  for (const [host, authority] of [['0.0.0.0', '127.0.0.1'], ['::', '[::1]'],
    ['::1', '[::1]'], ['192.0.2.10', '192.0.2.10']]) {
    assert.equal(localBaseUrl({ host, port: 8080 }), `http://${authority}:8080`);
  }
});

test('HTTP 工厂拒绝非回环无密钥配置', () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
    assert.throws(() => createHttpServer({ config: { ...config, host, apiKeys: [] } }), /PROXY_API_KEYS/);
  }
  assert.equal(validateListenConfig({ host: '127.0.0.2' }).loopbackOnly, true);
  assert.throws(() => validateListenConfig({ host: 'untrusted.example', apiKeys: ['key'] }), /PROXY_BIND_HOST/);
});

for (const script of ['proxy.js', 'dashboard.js']) {
  test(`${script} 在启动子进程或监听前拒绝无效配置`, () => {
    for (const overrides of [
      { PROXY_BIND_HOST: '0.0.0.0', PROXY_API_KEYS: ' , , ' },
      { PROXY_BIND_HOST: '::', PROXY_API_KEYS: '' },
      { PROXY_BIND_HOST: '   ', PROXY_API_KEYS: 'key' },
      { PROXY_BIND_HOST: '127.0.0.1', PROXY_API_KEYS: 'has space' },
    ]) {
      const child = spawnSync(process.execPath, [path.resolve(__dirname, '..', script)], {
        env: createTestEnv(process.env.MADMODEL_STATE_DIR, overrides),
        encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /PROXY_(API_KEYS|BIND_HOST)/);
      assert.equal(child.stdout, '');
    }
  });
}
