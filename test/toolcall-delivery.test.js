// 完整缓冲模式的工具交付：完整性校验、SSE/JSON 适配、结束原因与思考透传。
'use strict';
require('../scripts/isolated-env').isolate();

// 环境注入必须在 require config/paths 之前(加载期读取)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tcfix-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'tcfix-token', expiresAt: Date.now() + 3600e3 }));
process.env.PROXY_TOKEN_FILE = TOKEN_FILE;
process.env.MADMODEL_FORCE_TUNNEL_MODE = '1';
process.env.PROXY_TOOL_STREAM = 'buffered';

const test = require('node:test');
const assert = require('node:assert');

function startMockUpstream() {
  let handler = null;
  const server = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// 上游应答助手
function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const USAGE = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
// 标记文本仅作为正文交付，不转换成工具调用。
const DSML = '<｜DSML｜tool_calls><｜DSML｜invoke name="Bash">' +
  '<｜DSML｜parameter name="command" string="true">Get-Location</｜DSML｜parameter>' +
  '</｜DSML｜invoke></｜DSML｜tool_calls>';
function jsonCompletion(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'j1', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
  }));
}

const TOOLS = [{ type: 'function', function: { name: 'Bash', description: 'Run a shell command.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];

test('原生工具调用交付', async t => {
  const mock = await startMockUpstream();
  const port = await freePort();
  process.env.PROXY_UPSTREAM = `http://127.0.0.1:${mock.port}/v1/chat/completions`;
  process.env.PROXY_PORT = String(port);
  const config = require('../config');
  const { createUpstreamClient } = require('../core/upstream-client');
  const { createProxyService } = require('../core/proxy-service');
  const { createHttpServer, createTokenCache, createTokenState, createCredentialWaiter } = require('../adapters/http-server');
  const getToken = createTokenCache(config);
  const service = createProxyService({
    config, tokenState: createTokenState(getToken),
    upstreamClient: createUpstreamClient(config),
    waitForCredentials: createCredentialWaiter(getToken),
  });
  const httpServer = createHttpServer({ config, service, getToken });
  await new Promise(res => httpServer.server.listen(port, '127.0.0.1', res));
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

  // 记录上游请求次数。
  let seen = [];
  const chat = async (stream, extra = {}, onHeaders) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash',
        messages: [{ role: 'user', content: '用 Bash 执行 Get-Location' }], stream, max_tokens: 200, ...extra }),
    });
    if (onHeaders) await onHeaders(r);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  };
  // 从流式文本里抽出 tool_calls 与 content
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
      } catch (e) {}
    }
    return { tc, content, finish };
  };

  try {
    let totalPrompt = 0, totalCompletion = 0;
    const hermes = '<tool_call><function=Bash><parameter=command>Get-Location</parameter></function></tool_call>';
    for (const stream of [true, false]) {
      for (const upstream of ['sse', 'json']) {
        for (const [label, content] of [['空正文', ''], ['普通正文', '这是一句普通回答。'],
          ['DSML', DSML], ['Hermes', hermes]]) {
          await t.test(`${label} 原样交付且只请求一次: stream=${stream}, upstream=${upstream}`, async usageTest => {
            const logs = [];
            usageTest.mock.method(console, 'log', line => logs.push(line));
            seen = [];
            mock.set((req, res) => {
              req.resume();
              req.on('end', () => {
                seen.push(1);
                if (upstream === 'json') return jsonCompletion(res, content);
                sse(res, [JSON.stringify({ choices: [{ index: 0,
                  delta: { role: 'assistant', content }, finish_reason: 'stop' }] }), JSON.stringify(USAGE)]);
              });
            });
            const r = await chat(stream, { tools: TOOLS });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(seen.length, 1);
            const parts = stream ? streamParts(r.text) : {
              content: r.json.choices[0].message.content, tc: r.json.choices[0].message.tool_calls,
              finish: r.json.choices[0].finish_reason,
            };
            assert.strictEqual(parts.content ?? '', content);
            assert.ok(!parts.tc?.length, '正文不得被合成为工具调用');
            assert.strictEqual(parts.finish, 'stop');
            if (stream) assert.ok(r.text.trimEnd().endsWith('data: [DONE]'));
            const prompt = upstream === 'json' ? 9 : 1;
            const completion = upstream === 'json' ? 12 : 1;
            totalPrompt += prompt;
            totalCompletion += completion;
            const usageLogs = logs.filter(line => line.includes(' | token '));
            assert.strictEqual(usageLogs.length, 1, '每次客户端请求只记一次用量');
            assert.ok(usageLogs[0].includes(`token ${prompt}/${completion} `), usageLogs[0]);
            assert.ok(usageLogs[0].includes(`累计 ${totalPrompt}/${totalCompletion}`), usageLogs[0]);
          });
        }
      }
    }
    await t.test('原生 tool_calls 保留调用且只请求一次', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{
            index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
              function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] })]);
        });
      });
      const r = await chat(false, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '已有结构化调用时不得重发');
      assert.strictEqual(r.json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'Bash');
    });

    await t.test('流式结构化调用中途断流时,不得把半截 arguments 交付给客户端', async () => {
      seen = [];
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push(1);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, id: 'call_cut', type: 'function',
              function: { name: 'Bash', arguments: '{"command":"Get-ChildItem ' } }],
          }, finish_reason: null }] })}\n\n`);
          // 故意不发 [DONE],模拟网关/上游在工具参数中间断开。
          res.end();
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json?.error?.message.includes('截断'), r.text);
      assert.ok(!r.text.includes('tool_calls'), '截断响应不得包含半截 tool_calls: ' + r.text);
    });

    await t.test('即使上游发了 DONE,无效 JSON 的工具参数也不得交付', async () => {
      seen = [];
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push(1);
          sse(res, [JSON.stringify({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, id: 'call_bad', type: 'function',
              function: { name: 'Bash', arguments: '{"command":' } }],
          }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          ]);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json?.error?.message.includes('不是有效 JSON'), r.text);
      assert.ok(!r.text.includes('tool_calls'), '无效参数不得交付: ' + r.text);
    });

    // 校验与交付必须使用同一份完整调用集合，不能在聚合时过滤或转换坏字段。
    const completeCall = { index: 0, id: 'call_ok', type: 'function',
      function: { name: 'Bash', arguments: '{"command":"Get-Location"}' } };
    const invalidCalls = [
      ['缺 id/name 的半截调用', { index: 1, function: { arguments: '{"command":' } }],
      ['缺 id', { index: 1, type: 'function', function: { name: 'Bash', arguments: '{}' } }],
      ['缺 name', { index: 1, id: 'call_bad', type: 'function', function: { arguments: '{}' } }],
      ['非法 type', { ...completeCall, index: 1, id: 'call_bad', type: 'invalid-type' }],
      ['数字 name', { ...completeCall, index: 1, id: 'call_bad', function: { name: 123, arguments: '{}' } }],
      ['数组 arguments', { ...completeCall, index: 1, id: 'call_bad', function: { name: 'Bash', arguments: ['{}'] } }],
    ];
    for (const stream of [true, false]) {
      for (const upstreamFormat of ['sse', 'json']) {
        for (const [label, badCall] of invalidCalls) {
          await t.test(`交付校验拒绝${label}: stream=${stream}, upstream=${upstreamFormat}`, async () => {
            seen = [];
            mock.set((req, res) => {
              req.resume();
              req.on('end', () => {
                seen.push(1);
                const calls = [completeCall, badCall];
                if (upstreamFormat === 'sse') {
                  sse(res, [JSON.stringify({ choices: [{ index: 0,
                    delta: { tool_calls: calls }, finish_reason: null }] }),
                  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })]);
                } else {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ choices: [{ index: 0, message: {
                    role: 'assistant', content: null, tool_calls: calls,
                  }, finish_reason: 'tool_calls' }] }));
                }
              });
            });
            const r = await chat(stream, { tools: TOOLS });
            assert.strictEqual(seen.length, 1, '无效原生调用不得触发重试');
            assert.strictEqual(r.status, 502, r.text);
            assert.ok(r.json?.error?.message.includes('不是有效 JSON'), r.text);
            assert.ok(!r.text.includes('tool_calls'), '不得交付部分调用: ' + r.text);
            assert.ok(!r.text.includes('[DONE]'), '失败响应不得伪装成完整流');
          });
        }
      }
    }

    for (const stream of [true, false]) {
      for (const upstreamFormat of ['sse', 'json']) {
        for (const [label, calls] of [['缺少集合', undefined], ['null 集合', null],
          ['空集合', []], ['对象集合', {}], ['字符串集合', 'invalid']]) {
          await t.test(`拒绝用工具结束原因确认${label}: stream=${stream}, upstream=${upstreamFormat}`, async () => {
            mock.set((req, res) => {
              req.resume();
              req.on('end', () => {
                if (upstreamFormat === 'sse') {
                  sse(res, [JSON.stringify({ choices: [{ index: 0,
                    delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })]);
                } else {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ choices: [{ index: 0,
                    message: { role: 'assistant', tool_calls: calls }, finish_reason: 'tool_calls' }] }));
                }
              });
            });
            const r = await chat(stream, { tools: TOOLS });
            assert.strictEqual(r.status, 502, r.text);
            assert.ok(r.json?.error?.message.includes('不是有效 JSON'), r.text);
            assert.ok(!r.text.includes('[DONE]'));
          });
        }
      }
    }

    await t.test('思考已交付后发现坏工具调用，关闭流且不冲刷调用或 DONE', async () => {
      seen = [];
      let upstreamResponse;
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push(1);
          upstreamResponse = res;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0,
            delta: { reasoning_content: '先检查路径。' }, finish_reason: null }] })}\n\n`);
        });
      });
      const r = await chat(true, { tools: TOOLS }, () => {
        // Observe actual client headers before injecting the failure. The new
        // short prelude must not turn this into an assumption about write time.
        upstreamResponse.write(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: { tool_calls: [completeCall, invalidCalls[0][1]] }, finish_reason: 'tool_calls' }] })}\n\n`);
        upstreamResponse.end('data: [DONE]\n\n');
      });
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(r.status, 200, '思考已发出，HTTP 状态无法再改');
      assert.ok(r.text.includes('先检查路径。'));
      assert.ok(!r.text.includes('tool_calls'), '完整及半截调用均不得交付');
      assert.ok(!r.text.includes('[DONE]'), '客户端必须能识别响应未正常结束');
    });

    for (const stream of [true, false]) {
      await t.test(`正常多工具跨帧参数仍完整交付: stream=${stream}`, async () => {
        const frames = [
          { choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'Bash', arguments: '{"command":"' } },
            { index: 1, id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{"command":"' } },
          ] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [
            { index: 1, function: { arguments: 'Get-Location"}' } },
            { index: 0, function: { arguments: 'Get-Date"}' } },
          ] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ];
        seen = [];
        mock.set((req, res) => {
          req.resume();
          req.on('end', () => { seen.push(1); sse(res, frames.map(f => JSON.stringify(f))); });
        });
        const r = await chat(stream, { tools: TOOLS });
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(r.status, 200, r.text);
        if (stream) {
          const chunks = r.text.split('\n').filter(line => line.startsWith('data: {'))
            .map(line => JSON.parse(line.slice(6)));
          assert.deepStrictEqual(chunks, frames, '校验通过后保留原始 SSE 帧');
          assert.ok(r.text.trimEnd().endsWith('data: [DONE]'));
        } else {
          const calls = r.json.choices[0].message.tool_calls;
          assert.deepStrictEqual(calls.map(call => call.id), ['call_a', 'call_b']);
          assert.deepStrictEqual(calls.map(call => JSON.parse(call.function.arguments).command),
            ['Get-Date', 'Get-Location']);
        }
      });
    }

    // 真实 Qwen 指定工具的响应：参数合法，但结束原因错标为 stop。
    for (const stream of [true, false]) {
      for (const upstreamFormat of ['sse', 'json']) {
        for (const finish of ['stop', 'length']) {
          await t.test(`指定工具仅规范化 stop: stream=${stream}, upstream=${upstreamFormat}, finish=${finish}`, async () => {
            const call = { id: 'call_weather', type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } };
            seen = [];
            mock.set((req, res) => {
              req.resume();
              req.on('end', () => {
                seen.push(1);
                if (upstreamFormat === 'sse') {
                  sse(res, [JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
                    { ...call, index: 0, function: { name: 'get_weather', arguments: '{"city":' } },
                  ] }, finish_reason: null }] }),
                  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
                    { index: 0, function: { arguments: '"Beijing"}' } },
                  ] }, finish_reason: finish }] })]);
                } else {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ choices: [{ index: 0, message: {
                    role: 'assistant', content: null, tool_calls: [call],
                  }, finish_reason: finish }] }));
                }
              });
            });
            const r = await chat(stream, { model: 'qwen3.8-27b',
              tools: [{ type: 'function', function: { name: 'get_weather', parameters: {
                type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
              } } }], tool_choice: { type: 'function', function: { name: 'get_weather' } } });
            assert.strictEqual(seen.length, 1, '合法原生调用不得触发重试');
            assert.strictEqual(r.status, 200, r.text);
            let body = r.json;
            if (stream) {
              const agg = require('../core/completion-aggregator').createAggregator();
              for (const line of r.text.split('\n')) {
                if (line.startsWith('data: {')) agg.feed(JSON.parse(line.slice(6)));
              }
              body = agg.result();
              assert.ok(r.text.trimEnd().endsWith('data: [DONE]'));
            }
            assert.strictEqual(body.choices[0].finish_reason, finish === 'stop' ? 'tool_calls' : 'length');
            assert.deepStrictEqual(body.choices[0].message.tool_calls, [call]);
          });
        }
      }
    }

    for (const field of ['reasoning_content', 'content']) {
      await t.test(`带 tools 时 ${field} 在上游结束前交付`, async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let firstOutput;
        const first = new Promise(resolve => { firstOutput = resolve; });
        seen = [];
        mock.set((req, res) => {
          req.resume();
          req.on('end', async () => {
            seen.push(1);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0,
              delta: { [field]: '先检查路径。' }, finish_reason: null }] })}\n\n`);
            await gate;
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0,
              delta: { tool_calls: [completeCall] }, finish_reason: 'tool_calls' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          });
        });
        const payload = JSON.stringify({ model: 'DeepSeek-V4.1-Flash',
          messages: [{ role: 'user', content: 'test' }], tools: TOOLS, stream: true });
        const done = new Promise((resolve, reject) => {
          const req = http.request(url, { method: 'POST', headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
          } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
              text += chunk;
              if (text.includes('先检查路径。')) firstOutput();
            });
            res.on('end', () => resolve(text));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.end(payload);
        });
        let timer;
        let failure;
        try {
          await Promise.race([first, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${field} 被缓冲到上游结束`)), 2000);
          })]);
        } catch (error) { failure = error; }
        finally { clearTimeout(timer); release(); }
        const text = await done;
        if (failure) throw failure;
        assert.strictEqual(seen.length, 1);
        assert.strictEqual((text.match(/先检查路径。/g) || []).length, 1);
        assert.ok(text.includes('"tool_calls"'));
        assert.ok(text.trimEnd().endsWith('data: [DONE]'));
      });
    }

    await t.test('思考与工具在同一帧时完整交付，用量只出现一次', async () => {
      seen = [];
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push(1);
          sse(res, [JSON.stringify({ choices: [{ index: 0,
            delta: { reasoning: '先检查路径。', tool_calls: [completeCall] }, finish_reason: 'tool_calls' }] }),
            JSON.stringify(USAGE)]);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1);
      assert.strictEqual((r.text.match(/先检查路径。/g) || []).length, 1);
      assert.strictEqual((r.text.match(/"usage":/g) || []).length, 1);
      assert.ok(r.text.indexOf('"tool_calls":') < r.text.indexOf('"usage":'));
      assert.ok(r.text.trimEnd().endsWith('data: [DONE]'));
    });

  } finally {
    await new Promise(r => httpServer.server.close(r));
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) {}
  }
});
