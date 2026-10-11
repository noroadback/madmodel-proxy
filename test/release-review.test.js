'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { getEventListeners } = require('events');
const { parseToolCalls, stripToolMarkup, shouldProbeSwallowedCall } = require('../core/dsml');
const { translateUpstreamError } = require('../core/errors');
const { discoverWithCredentials } = require('../core/model-discovery');
const { createModelRegistry } = require('../core/model-registry');
const { createHttpServer, createTokenState } = require('../adapters/http-server');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');
const config = require('../config');

const hermes = (name, body = '') => `<tool_call><function=${name}>${body}</function></tool_call>`;
const param = (name, value) => `<parameter=${name}>\n${value}\n</parameter>`;
const tools = [{ type: 'function', function: { name: 'Write', parameters: {
  type: 'object', properties: { text: { type: 'string' }, n: { type: 'number' } },
} } }];

test('工具补救拒绝缺失闭合、重复参数及未提供的工具', () => {
  for (const value of [
    '<tool_call><function=Write></tool_call>',
    hermes('Write', param('text', 'a') + param('text', 'b')),
    hermes('Missing'),
    hermes('Write') + '<tool_call><function=Write>',
    hermes('Write', 'unparsed text'),
  ]) assert.equal(parseToolCalls(value, tools), null, value);
});

test('引用的工具格式示例不执行也不触发重发', () => {
  for (const quote of ['```xml\n', '~~~xml\n', '`']) {
    const sample = quote + hermes('Write') + (quote.startsWith('~') ? '\n~~~' : quote === '`' ? '`' : '\n```');
    assert.equal(parseToolCalls(sample, tools), null);
    assert.equal(shouldProbeSwallowedCall(sample), false);
  }
});

test('Hermes 按工具定义保持字符串，保留 __proto__ 参数', () => {
  const result = parseToolCalls(hermes('Write', param('text', '123') + param('n', '5') + param('__proto__', 'true')), tools);
  const args = JSON.parse(result[0].function.arguments);
  assert.equal(args.text, '123');
  assert.equal(args.n, 5);
  assert.equal(Object.hasOwn(args, '__proto__'), true);
  assert.equal(args.__proto__, 'true');
});

test('DSML 参数里的普通小于号不会泄漏到恢复后的正文', () => {
  const sample = '开始\n<｜DSML｜invoke name="Write"><｜DSML｜parameter name="text">a < b</｜DSML｜parameter></｜DSML｜invoke>结束';
  assert.equal(JSON.parse(parseToolCalls(sample, tools)[0].function.arguments).text, 'a < b');
  assert.equal(stripToolMarkup(sample), '开始\n结束');
});

test('JSON 错误详情不能覆盖 HTTP 413 和 429', () => {
  for (const status of [413, 429]) {
    assert.equal(translateUpstreamError({ message: 'rejected' }, '', status).http, status);
  }
});

test('启动探测重试使用 watch 更新后的凭据', async () => {
  let credentials = { token: 'old', cookie: 'old-cookie' };
  const received = [];
  const result = await discoverWithCredentials({
    getCredentials: () => credentials,
    wait: async () => { credentials = { token: 'new', cookie: 'new-cookie' }; },
    probe: async auth => {
      received.push(auth);
      return [{ id: 'm', ok: auth.token === 'new', reason: auth.token === 'old' ? 'session' : null }];
    },
  });
  assert.equal(result[0].ok, true);
  assert.deepEqual(received.map(x => x.cookie), ['old-cookie', 'new-cookie']);
});

test('模型快照的档位数组不可从外部修改', () => {
  const reg = createModelRegistry(config);
  const options = ['low'];
  reg.publish([{ id: 'm', ok: true, meta: { effortOptions: options } }]);
  options.push('invalid');
  assert.deepEqual(reg.snapshot()[0].meta.effortOptions, ['low']);
  assert.throws(() => reg.snapshot()[0].meta.effortOptions.push('invalid'), TypeError);
  reg.publish([{ id: config.model, ok: false, reason: 'not-found' }]);
  assert.deepEqual(reg.available(), []);
});

test('无效或到期的 token 不可作为有效凭据放行', () => {
  for (const expiresAt of [NaN, Infinity, 'invalid', 0, Date.now() - 1]) {
    assert.equal(createTokenState(() => ({ token: 'fake', expiresAt }))().code, 'token-expired');
  }
});

test('重复请求结束后清除共享 AbortSignal 监听器', async () => {
  const ac = new AbortController();
  const request = createUpstreamClient({ ...config, upstream: 'data:application/json,%7B%7D' }).request;
  for (let i = 0; i < 12; i++) {
    await request({ payload: {}, token: 'fake', signal: ac.signal });
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  }
});

test('动态不可关闭思考模型的元数据实际参与请求映射', async () => {
  let sent;
  const registry = createModelRegistry(config);
  registry.publish([{ id: 'dynamic-r1', ok: true, meta: {
    thinkingParam: null, thinkingField: 'reasoning', effortOptions: ['low', 'high'],
  } }]);
  const service = createProxyService({ config, modelRegistry: registry,
    tokenState: () => ({ ok: true, token: 'fake', msLeft: 3600000 }),
    upstreamClient: { request: async ({ payload }) => {
      sent = payload;
      return { type: 'completion', body: { choices: [{ message: { content: 'ok' } }] } };
    } },
  });
  await service.handleRequest({ rawBody: Buffer.from(JSON.stringify({ model: 'dynamic-r1',
    messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' })),
    started: Date.now(), size: 1, abortController: new AbortController(),
    setExtraHeaders() {}, clientGone: () => false, headersSent: () => false,
    sendJson() {}, sendError(status, message) { assert.fail(`${status}: ${message}`); },
  });
  assert.equal(sent.reasoning_effort, 'high');
  assert.equal(sent.chat_template_kwargs, undefined);
});

test('HTTP 拒绝伪前缀路由，R1 reasoning 标记正确，异常流能结束', async () => {
  const registry = createModelRegistry(config);
  registry.publish([{ id: 'r1', ok: true, meta: { thinkingParam: null, thinkingField: 'content', effortOptions: ['low'] } }]);
  const service = { logReq() {}, async handleRequest(ctx) {
    await ctx.writeSseChunk({ choices: [] });
    throw new Error('test failure');
  } };
  const probe = require('net').createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const { server } = createHttpServer({ config: { ...config, port }, service, modelRegistry: registry, getToken: () => null });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json' };
  try {
    const models = await fetch(base + '/v1/models', { headers }).then(r => r.json());
    assert.equal(models.data[0].reasoning.supported, true);
    assert.equal((await fetch(base + '/wrong/v1/chat/completions', { method: 'POST', headers })).status, 404);
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2000) });
    assert.match(await response.text(), /^data:/);
  } finally { await new Promise(r => server.close(r)); }
});

test('管道一次送入两行凭据仍能完成登录输入', () => {
  const source = `const auth = require('./auth-service');
    auth.login = async value => {
      require('node:assert/strict').deepEqual(value, { username: 'sample', password: ' fake password ' });
      return { expiresAt: Date.now()+10000, fingerPrint: '12345678', tokenFile: 'test-token', credsFile: 'test-creds' };
    };
    require('./adapters/cli').runCli(['login']);`;
  const out = execFileSync(process.execPath, ['-e', source], {
    cwd: require('path').resolve(__dirname, '..'), input: 'sample\n fake password \n', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, MSYSTEM: '', MINGW_PREFIX: '', TERM_PROGRAM: '' },
  });
  assert.match(out, /token 已获取/);
});

test('清除凭据遇到权限错误时不报告成功', () => {
  const fs = require('fs');
  const original = fs.unlinkSync;
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  fs.unlinkSync = () => { throw failure; };
  try {
    const store = require('../platform/credential-store')({ protect: x => x, unprotect: x => x });
    assert.throws(() => store.clearAll(), e => e === failure);
  } finally { fs.unlinkSync = original; }
});

test('认证重定向正确解析协议相对地址、查询串和父路径', () => {
  const { resolveUrl } = require('../madmodel-auth');
  const base = 'https://id.tsinghua.edu.cn/auth/form?old=1';
  assert.equal(resolveUrl(base, '//webvpn.tsinghua.edu.cn/login'), 'https://webvpn.tsinghua.edu.cn/login');
  assert.equal(resolveUrl(base, '?next=1'), 'https://id.tsinghua.edu.cn/auth/form?next=1');
  assert.equal(resolveUrl(base, '../done'), 'https://id.tsinghua.edu.cn/done');
});
