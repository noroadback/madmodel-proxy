// test/model-routing.test.js — 1.10.1 的主契约:按客户端选择的模型真实路由。
//
// 为什么单独一个文件:这是本版本**最核心的行为变更**(从前是"无论客户端写什么
// 都改写成 config.model 单一目标"),但原有的测试全部只发同一个模型名、mock 上游
// 也不校验收到的 model——等于主契约没有回归钉。若有人日后再把 requestedModel
// 改回 config.model,所有旧测试仍会全绿(2026-09-28 审阅指出)。
'use strict';
require('../scripts/isolated-env').isolate();

// 环境注入必须在 require config/paths 之前(加载期读取)。
// 本文件全程用 mock 上游,**不得依赖真实 token**——否则 token 一过期,
// 代理会在到达 mock 之前就回 401,测试失败却与路由无关(2026-09-28 实际踩到:
// 真实 token 过期 187 分钟导致 8 条用例全红)。与 toolcall-delivery.test.js 同法
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-route-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'route-test-token', expiresAt: Date.now() + 3600e3 }));
process.env.PROXY_TOKEN_FILE = TOKEN_FILE;
process.env.MADMODEL_FORCE_TUNNEL_MODE = '1';

const test = require('node:test');
const assert = require('node:assert');

function startMockUpstream() {
  let handler = null;
  const server = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 未配置 handler' } }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, set: h => { handler = h; },
    }));
  });
}

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const OK_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
];

test('按客户端选择路由:三个模型各发各的,不再被改写成单一目标', async t => {
  const mock = await startMockUpstream();
  const port = await freePort();
  process.env.PROXY_UPSTREAM = `http://127.0.0.1:${mock.port}/v1/chat/completions`;
  process.env.PROXY_PORT = String(port);
  const config = require('../config');
  const { createUpstreamClient } = require('../core/upstream-client');
  const { createProxyService } = require('../core/proxy-service');
  const { createModelRegistry } = require('../core/model-registry');
  const { createHttpServer, createTokenCache, createTokenState, createCredentialWaiter } = require('../adapters/http-server');
  const getToken = createTokenCache(config);
  // 注入一个"已探测完成"的清单,让 /v1/models 与能力查找走真实路径
  // (生产里由启动探测 publish,测试直接给等价结果)
  const modelRegistry = createModelRegistry(config);
  modelRegistry.publish([
    { id: 'DeepSeek-V4.1-Flash', ok: true, ms: 100, meta: config.thinkingFallback['DeepSeek-V4.1-Flash'] },
    { id: 'qwen3.8-27b', ok: true, ms: 130, meta: config.thinkingFallback['qwen3.8-27b'] },
    { id: 'DeepSeek-R1-W8A8', ok: true, ms: 140, meta: config.thinkingFallback['DeepSeek-R1-W8A8'] },
  ]);
  const service = createProxyService({
    config, tokenState: createTokenState(getToken),
    upstreamClient: createUpstreamClient(config),
    waitForCredentials: createCredentialWaiter(getToken),
    modelRegistry,
  });
  const httpServer = createHttpServer({ config, service, getToken, modelRegistry });
  await new Promise(res => httpServer.server.listen(port, '127.0.0.1', res));
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

  // 记录 mock 上游实际收到的请求体
  let got = [];
  mock.set((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      let o = null; try { o = JSON.parse(b); } catch (e) {}
      got.push(o);
      sse(res, OK_FRAMES);
    });
  });

  const chat = async model => {
    const body = { messages: [{ role: 'user', content: 'hi' }], stream: true };
    if (model !== undefined) body.model = model;
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await r.text();
    return r.status;
  };

  try {
    await t.test('客户端写 V4.1 → 上游收到 V4.1(而非任何代理挑的模型)', async () => {
      got = [];
      const st = await chat('DeepSeek-V4.1-Flash');
      assert.strictEqual(st, 200);
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].model, 'DeepSeek-V4.1-Flash',
        `上游应收到客户端选的模型,实际 ${got[0].model}`);
    });

    await t.test('选一个**与 config.MODEL 不同**的模型 → 也原样收到(证明路由不看 config)', async () => {
      // 这条不依赖 config.model 恰好是谁:挑一个肯定不是它的现存模型。
      // 旧行为(恒改写)下这里必然变红
      const other = ['DeepSeek-V4.1-Flash', 'qwen3.8-27b', 'DeepSeek-R1-W8A8']
        .find(m => m !== config.model);
      got = [];
      await chat(other);
      assert.strictEqual(got[0].model, other,
        `config.MODEL=${config.model},但客户端选的是 ${other},不得被换掉`);
    });

    await t.test('客户端写 qwen → 上游收到 qwen,且思考字段用 enable_thinking', async () => {
      got = [];
      await chat('qwen3.8-27b');
      assert.strictEqual(got[0].model, 'qwen3.8-27b');
      // 逐模型翻译:qwen 的开关字段是 enable_thinking,不是 thinking
      assert.deepStrictEqual(got[0].chat_template_kwargs, { enable_thinking: true },
        'qwen 必须用自己的字段名');
    });

    await t.test('客户端写 R1 → 上游收到 R1,且不发思考开关(该模型不可开关)', async () => {
      got = [];
      await chat('DeepSeek-R1-W8A8');
      assert.strictEqual(got[0].model, 'DeepSeek-R1-W8A8');
      assert.ok(!('chat_template_kwargs' in got[0]), 'R1 的 thinkingParam 为 null,不该注入开关');
    });

    await t.test('R1 工具历史经流式和非流式 HTTP 请求转发后仍保留结果', async () => {
      for (const stream of [true, false]) {
        for (const content of [null, '']) {
          got = [];
          const messages = [
            { role: 'user', content: 'Read the record.' },
            { role: 'assistant', content, tool_calls: [{ id: 'c1', type: 'function',
              function: { name: 'read_record', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"verification_code":"573826"}' },
            { role: 'user', content: 'What was the verification code?' },
          ];
          const response = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'DeepSeek-R1-W8A8', messages, stream,
              tools: [{ type: 'function', function: { name: 'read_record' } }], tool_choice: 'auto' }),
          });
          await response.text();
          assert.strictEqual(response.status, 200);
          assert.strictEqual(got.length, 1);
          const expected = structuredClone(messages);
          delete expected[1].tool_calls;
          assert.deepStrictEqual(got[0].messages, expected);
          assert.ok(!('tools' in got[0]) && !('tool_choice' in got[0]));
        }
      }
    });

    await t.test('未知模型名照发不误(让上游回"模型不存在",不偷偷换模型)', async () => {
      got = [];
      await chat('no-such-model-xyz');
      assert.strictEqual(got[0].model, 'no-such-model-xyz',
        '未知名字必须原样转发,不得被替换成默认模型');
    });

    await t.test('客户端没写 model → 原样转发空值(代理不替用户挑模型)', async () => {
      // 1.10.1 定案:去掉回退。客户端没表达选择时,让上游如实回"模型不存在",
      // 而不是被代理换成一个用户没选过的模型(静默替换会让用户以为用的是自己选的)
      got = [];
      await chat(undefined);
      assert.ok(got[0].model === undefined || got[0].model === null || got[0].model === '',
        '不得把缺失的 model 填成 config.model,实际:' + JSON.stringify(got[0].model));
    });

    await t.test('空串与空白串同样不回退(不得被换成 config.model)', async () => {
      // 契约只有一条:**不得回退成 config.model**。空值具体以什么形态到达上游
      // (空串原样 / 空白被 trim 成空)不是本测试要钉的——上游对两者都会回
      // "模型不存在",那是预期的如实失败
      for (const bad of ['', '   ']) {
        got = [];
        await chat(bad);
        const m = got[0].model;
        assert.notStrictEqual(m, config.model,
          `空/空白 model 不得回退成 config.model(${config.model}):${JSON.stringify(bad)}`);
        assert.ok(typeof m === 'string' && m.trim() === '',
          `应保持空值,实际 ${JSON.stringify(m)}`);
      }
    });

    await t.test('逐模型输出上限：DeepSeek 保留大预算，Qwen 常规请求按流式预算适配', async () => {
      got = [];
      await chat('DeepSeek-V4.1-Flash');
      // 客户端发 900000:1M 窗口内应原样放行
      got = [];
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 900000 }) })
        .then(r => r.text());
      assert.strictEqual(got[0].max_tokens, 900000, '1M 模型不得被压到 65536');
      assert.strictEqual(got[0].model, 'DeepSeek-V4.1-Flash');

      for (const stream of [true, false]) {
        got = [];
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], stream, max_tokens: 900000 }) });
        await r.text();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(got[0].stream, true);
        assert.ok(got[0].max_tokens <= 262000, `qwen 应收缩到模型预算内，实际 ${got[0].max_tokens}`);
        assert.ok(got[0].max_tokens > 131072, '客户端选非流式也不应套用上游非流式上限');
      }
    });

    await t.test('R1 保留已接受的 160000 输出预算，过大预算按共享窗口收缩', async () => {
      for (const maxTokens of [160000, 900000]) {
        got = [];
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'DeepSeek-R1-W8A8', messages: [{ role: 'user', content: 'hi' }],
            stream: true, max_tokens: maxTokens }) });
        await r.text();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0].model, 'DeepSeek-R1-W8A8');
        if (maxTokens === 160000) {
          assert.strictEqual(got[0].max_tokens, 160000, '不得再压到默认模型的 65536');
        } else {
          assert.ok(got[0].max_tokens > 160000);
          assert.ok(got[0].max_tokens < 163840 - 1024, '共享窗口须扣除输入及通用预留量');
        }
      }
    });

    await t.test('/v1/models 按模型发布各自窗口(不再是一个统一值)', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const j = await r.json();
      const byId = Object.fromEntries(j.data.map(m => [m.id, m]));
      assert.strictEqual(byId['DeepSeek-V4.1-Flash'].context_window, 1048576);
      assert.strictEqual(byId['qwen3.8-27b'].context_window, 262144);
      assert.strictEqual(byId['qwen3.8-27b'].max_output_tokens, 262000);
      assert.strictEqual(byId['DeepSeek-R1-W8A8'].context_window, 163840);
      assert.strictEqual(byId['DeepSeek-R1-W8A8'].max_output_tokens, 163840);
      // 三者窗口不该全都相同(那就是旧的单一值行为)
      const wins = new Set(j.data.map(m => m.context_window));
      assert.ok(wins.size > 1, '不同模型的窗口应各不相同,实际:' + [...wins].join(','));
    });
  } finally {
    await new Promise(res => httpServer.server.close(res));
    await new Promise(res => mock.server.close(res));
  }
});
