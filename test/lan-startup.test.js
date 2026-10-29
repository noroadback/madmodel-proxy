'use strict';
const { isolate, createTestEnv } = require('../scripts/isolated-env');
isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message());
}

function start(t, script, env, args = []) {
  const preload = path.join(env.MADMODEL_STATE_DIR, 'preload.cjs');
  fs.writeFileSync(preload, `
    const realFetch = global.fetch;
    global.fetch = async (url, options) => {
      const address = String(url);
      if (address === 'https://madmodel.cs.tsinghua.edu.cn/')
        return new Response('<script src="/index-test.js"></script>');
      if (address === 'https://madmodel.cs.tsinghua.edu.cn/index-test.js')
        return new Response('const data={modelList:[{label:"Flash",value:"DeepSeek-V4.1-Flash",supportImage:!0},{label:"Qwen",value:"qwen3.8-27b"},{label:"R1",value:"DeepSeek-R1-W8A8"}]};');
      if (address.startsWith('http://127.0.0.1:')) return realFetch(url, options);
      throw new Error('Test blocked external request');
    };
    process.on('message', message => {
      if (message === 'stop') {
        if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
        else process.exit(0);
      }
    });
    process.channel?.unref();
  `);
  const child = spawn(process.execPath, ['--require', preload, path.join(ROOT, script), ...args], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.send('stop');
    const timer = setTimeout(() => child.kill(), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  t.after(stop);
  return { child, stop, output: () => output };
}

test('真实入口在登录后发现模型，鉴权不影响流式、非流式和登出保护', async t => {
  const state = fs.mkdtempSync(path.join(process.env.MADMODEL_STATE_DIR, 'proxy-'));
  const seen = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push({ payload, headers: req.headers });
      if (!payload.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of [
        { id: 'mock', model: payload.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  t.after(() => new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); }));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const env = createTestEnv(state, { PROXY_PORT: String(port), PROXY_BIND_HOST: '127.0.0.1',
    PROXY_API_KEYS: 'client-only-key', PROXY_TOKEN_FILE: path.join(state, 'fake-token.json'),
    PROXY_UPSTREAM: `http://127.0.0.1:${mock.address().port}/v1/chat/completions` });
  const app = start(t, 'proxy.js', env);
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    try { return (await fetch(base + '/healthz')).status === 200; } catch { return false; }
  }, app.output);
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  assert.equal(seen.length, 0, '未登录或未授权不能发送上游请求');
  const headers = { Authorization: 'Bearer client-only-key', 'Content-Type': 'application/json' };
  fs.writeFileSync(env.PROXY_TOKEN_FILE, JSON.stringify({ token: 'school-only-token', expiresAt: Date.now() + 3600000 }));
  let models;
  await until(async () => {
    models = (await (await fetch(base + '/v1/models', { headers })).json()).data;
    return models.length === 3 && models.every(m => m.available === true);
  }, app.output);
  assert.equal(models.find(m => m.id === 'DeepSeek-V4.1-Flash').supports_vision, true);
  for (const model of models.map(m => m.id)) {
    for (const stream of [false, true]) {
      const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }) });
      assert.equal(res.status, 200);
      if (stream) assert.match(await res.text(), /data: \[DONE\]/);
      else assert.equal((await res.json()).choices[0].message.content, 'ok');
    }
  }
  assert.equal(seen.length, 9, '三次模型探测和六次对话');
  assert.ok(seen.every(r => r.headers.authorization === 'Bearer school-only-token' && !r.headers['x-api-key']));
  assert.ok(!JSON.stringify(seen).includes('client-only-key'));
  assert.ok(!app.output().includes('client-only-key'));
  const options = { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 10000 };
  await exec(process.execPath, [path.join(ROOT, 'core/proxy-status.js')], options);
  const marker = path.join(state, 'creds.json');
  fs.writeFileSync(marker, 'keep-me');
  const script = `require('./auth-service').logout().then(()=>process.exit(1)).catch(e=>process.stdout.write(e.message))`;
  const result = await exec(process.execPath, ['-e', script], options);
  assert.match(result.stdout, /代理仍在运行/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep-me');
});

test('dashboard 显式 offcampus 覆盖校园网记录，SIGTERM 停止子进程', async t => {
  const state = fs.mkdtempSync(path.join(process.env.MADMODEL_STATE_DIR, 'dashboard-'));
  fs.writeFileSync(path.join(state, 'network-choice.json'), JSON.stringify({ mode: 'campus' }));
  const port = await freePort();
  const env = createTestEnv(state, { PROXY_PORT: String(port), PROXY_API_KEYS: 'local-key' });
  const app = start(t, 'dashboard.js', env, ['offcampus']);
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; }
  }, app.output);
  assert.match(app.output(), /当前:校外 WebVPN 隧道/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'network-choice.json'), 'utf8')).mode, 'offcampus');
  await app.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  const lockFile = path.join(state, 'watch.lock');
  if (fs.existsSync(lockFile)) {
    const pid = require('../platform/process-lock').pidOf(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(require('../platform/process-lock').isAlive(pid), false);
  }
});
