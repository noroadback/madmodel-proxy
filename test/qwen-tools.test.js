// qwen3.8-27b 原生工具调用：保留客户端选择，流式和聚合响应均交付原生调用。
// 2026-10-17 上游已支持原生 auto；required/指定工具在此只验证代理原样转发，
// 不据 mock 声称上游也已实测支持。完整 Hermes 文本仍可恢复，none 禁止补救。
'use strict';
require('../scripts/isolated-env').isolate();

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-qwent-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'qwen-test-token', expiresAt: Date.now() + 3600e3 }));
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

// 历史实测的 Hermes 调用文本，继续作为原生调用缺失时的恢复样本。
const HERMES_TEXT = '\n\n<tool_call>\n<function=get_weather>\n<parameter=city>\n北京\n</parameter>\n</function>\n</tool_call>';
const HERMES_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: HERMES_TEXT }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
];
const NATIVE_CALL = { id: 'call_native_qwen', type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"北京"}' } };
const NATIVE_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...NATIVE_CALL }] }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
];

const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: '查询城市天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

test('qwen 原生工具调用与文本恢复', async t => {
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
  const modelRegistry = createModelRegistry(config);
  modelRegistry.publish([
    { id: 'qwen3.8-27b', ok: true, ms: 100, meta: config.thinkingFallback['qwen3.8-27b'] },
    { id: 'DeepSeek-V4.1-Flash', ok: true, ms: 110, meta: config.thinkingFallback['DeepSeek-V4.1-Flash'] },
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

  let got = [];
  let frames = HERMES_FRAMES;
  mock.set((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      let o = null; try { o = JSON.parse(b); } catch (e) {}
      got.push(o);
      sse(res, frames);
    });
  });

  const chat = async (body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, text, json };
  };
  // 从 SSE 里抽 tool_calls 与 content
  const streamParts = text => {
    let tc = null, content = '', finish = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      try {
        const j = JSON.parse(line.slice(5));
        const ch = j.choices?.[0]; const d = ch?.delta;
        if (d?.tool_calls) tc = d.tool_calls;
        if (typeof d?.content === 'string') content += d.content;
        if (ch?.finish_reason) finish = ch.finish_reason;
      } catch (e) { /* 非 JSON 行 */ }
    }
    return { tc, content, finish };
  };

  try {
    for (const stream of [true, false]) {
      for (const choice of [undefined, 'auto', 'required', { type: 'function', function: { name: 'get_weather' } }]) {
        await t.test(`原生调用保持选择与调用 ID：stream=${stream}, choice=${JSON.stringify(choice)}`, async () => {
          got = [];
          // 2026-10-17 指定工具的实测响应有完整调用，但上游结束标记为 stop。
          frames = typeof choice === 'object' ? NATIVE_FRAMES.map(frame => {
            const obj = JSON.parse(frame);
            if (obj.choices[0].finish_reason === 'tool_calls') obj.choices[0].finish_reason = 'stop';
            return JSON.stringify(obj);
          }) : NATIVE_FRAMES;
          const r = await chat({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: '北京天气' }],
            tools: TOOLS, stream, ...(choice === undefined ? {} : { tool_choice: choice }) });
          assert.strictEqual(r.status, 200);
          assert.strictEqual(got.length, 1, '原生调用无需补救重试');
          assert.deepStrictEqual(got[0].tool_choice, choice, '不得将客户端的工具选择降级为 none');
          assert.deepStrictEqual(got[0].tools, TOOLS);
          assert.strictEqual(got[0].stream, true, '非流式客户端的常规上游请求也使用 SSE');
          const calls = stream ? streamParts(r.text).tc : r.json?.choices?.[0]?.message?.tool_calls;
          const finish = stream ? streamParts(r.text).finish : r.json?.choices?.[0]?.finish_reason;
          assert.strictEqual(calls?.length, 1);
          assert.strictEqual(calls[0].id, NATIVE_CALL.id, '保留原生调用 ID，不以文本恢复结果替换');
          assert.strictEqual(calls[0].type, 'function');
          assert.deepStrictEqual(calls[0].function, NATIVE_CALL.function);
          assert.strictEqual(finish, 'tool_calls');
        });
      }
      await t.test(`完整 Hermes 文本继续恢复，无需降级或重试：stream=${stream}`, async () => {
        got = [];
        frames = HERMES_FRAMES;
        const r = await chat({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: '北京天气' }],
          tools: TOOLS, tool_choice: 'auto', stream });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0].tool_choice, 'auto');
        const calls = stream ? streamParts(r.text).tc : r.json?.choices?.[0]?.message?.tool_calls;
        const finish = stream ? streamParts(r.text).finish : r.json?.choices?.[0]?.finish_reason;
        const content = stream ? streamParts(r.text).content : r.json?.choices?.[0]?.message?.content;
        assert.strictEqual(calls?.length, 1);
        assert.strictEqual(calls[0].function.name, 'get_weather');
        assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
        assert.strictEqual(finish, 'tool_calls');
        assert.ok(!/<tool_call>/.test(content || ''), '恢复后清除正文中的调用标记');
      });
    }

    for (const stream of [true, false]) {
      await t.test(`客户端明确要 none → 保留选择，不合成调用：stream=${stream}`, async () => {
        got = [];
        const r = await chat({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: '北京天气' }], tools: TOOLS, tool_choice: 'none', stream });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0].tool_choice, 'none');
        const calls = stream ? streamParts(r.text).tc : r.json?.choices?.[0]?.message?.tool_calls;
        const finish = stream ? streamParts(r.text).finish : r.json?.choices?.[0]?.finish_reason;
        assert.ok(!calls?.length, '客户端要 none 时不得合成调用(哪怕模型吐了标记文本)');
        assert.strictEqual(finish, 'stop');
      });
    }

    await t.test('内部标记不外泄到上游', async () => {
      got = [];
      await chat({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: '北京天气' }], tools: TOOLS, stream: true });
      const keys = Object.keys(got[0]);
      const leaked = keys.filter(k => k.startsWith('__'));
      assert.deepStrictEqual(leaked, [], '不得把代理内部字段发给上游:' + leaked.join(','));
    });

    await t.test('不带 tools → 不降级(请求体保持原样)', async () => {
      got = [];
      await chat({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: '你好' }], stream: true });
      assert.strictEqual(got[0].tool_choice, undefined, '没有 tools 时不该动 tool_choice');
    });

    await t.test('其它模型不被降级(V4.1 原生路径不受影响)', async () => {
      got = [];
      await chat({ model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: '北京天气' }], tools: TOOLS, stream: true });
      assert.strictEqual(got[0].model, 'DeepSeek-V4.1-Flash');
      assert.strictEqual(got[0].tool_choice, undefined, 'V4.1 原生支持 tools,不得降级');
    });

    await t.test('客户端要 none 时不得靠伪造内部标记重开补救(防伪造回归钉)', async () => {
      // 客户端不能借用内部字段把自己的 none 伪装成代理降级后的选择。
      // 入口须剔除全部内部键，工具恢复仍须遵守客户端原始选择。
      got = [];
      const r = await chat({
        model: 'qwen3.8-27b',
        messages: [{ role: 'user', content: '这段话里提到了 <｜DSML｜invoke name="Bash"> 的写法' }],
        tools: TOOLS,
        tool_choice: 'none',
        __toolsDowngraded: true, // ← 伪造
        __clientToolChoice: 'auto',
        stream: true,
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].tool_choice, 'none');
      const p = streamParts(r.text);
      assert.ok(!p.tc, '不得因客户端伪造内部标记而合成调用');
      assert.strictEqual(p.finish, 'stop', 'finish_reason 不得被改成 tool_calls');
      // 同时确认那个伪造字段没有外泄到上游
      const leaked = Object.keys(got[0] || {}).filter(k => k.startsWith('__'));
      assert.deepStrictEqual(leaked, [], '伪造字段不得转发给上游:' + leaked.join(','));
    });

    await t.test('客户端传的其它 __ 前缀键也被剔除(内部命名空间不与输入共用)', async () => {
      got = [];
      await chat({
        model: 'qwen3.8-27b', messages: [{ role: 'user', content: '天气' }],
        tools: TOOLS, __anything: 'x', __toolsDowngraded: false, stream: true,
      });
      const leaked = Object.keys(got[0] || {}).filter(k => k.startsWith('__'));
      assert.deepStrictEqual(leaked, [], '所有 __ 前缀键都应被剔除:' + leaked.join(','));
      assert.strictEqual(got[0].tool_choice, undefined, '省略的工具选择不应被改成 none');
    });
  } finally {
    await new Promise(res => httpServer.server.close(res));
    await new Promise(res => mock.server.close(res));
  }
});
