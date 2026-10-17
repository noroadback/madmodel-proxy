// test/toolcall-fix.test.js — 工具调用补救(1.10.1)的集成验证。
//
// 为什么需要:2026-09-27 实测学校上游只在**非流式**请求下返回工具调用,且是
// 自有方言的纯文本(<｜DSML｜invoke name="X">…),结构化 tool_calls 恒为 null;
// 而本代理为绕学校 60s 网关对上游**强制流式**,流式下上游连该文本都不返回——
// 客户端收到空回复,表现为"一调工具就中断"。
// 补救:带 tools 的请求若流式返回空,用非流式重发一次拿到文本、解析成结构化
// tool_calls 交付。
//
// 本文件钉住:① 补救确实触发且客户端拿到结构化调用 ② 不该触发的形态一律不
// 触发(不误伤正常对话/正常工具响应/无 tools 请求)③ 解析不出时不伪造
// ④ 关掉开关时恢复纯透传。全程 mock 上游,不访问学校服务。
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
process.env.PROXY_RETRY_WAIT_MS = '1000';

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
// "被吞掉工具调用"的空响应:role 帧 + 空 content + stop(实测形态)
const EMPTY_TOOL_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
];
const CH = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '好的' } }] };
const USAGE = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
// 上游非流式返回的 DSML 文本(逐字抄自实测样本)
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

test('工具调用补救(1.10.1)', async t => {
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

  // 记录上游收到的每次请求体,用于断言"重发了几次、第二次是不是非流式"
  let seen = [];
  const chat = async (stream, extra = {}) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash',
        messages: [{ role: 'user', content: '用 Bash 执行 Get-Location' }], stream, max_tokens: 200, ...extra }),
    });
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
    for (const stream of [true, false]) {
      for (const recovery of ['inline', 'retry', 'unparsed']) {
        await t.test(`用量记录不漏计、不重复计入: stream=${stream}, ${recovery}`, async usageTest => {
          const logs = [];
          usageTest.mock.method(console, 'log', line => logs.push(line));
          seen = [];
          mock.set((req, res) => {
            req.resume();
            req.on('end', () => {
              seen.push(1);
              if (seen.length > 1) return jsonCompletion(res, recovery === 'retry' ? DSML : '普通回答');
              const content = recovery === 'inline' ? DSML : '';
              sse(res, [JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }),
                JSON.stringify(USAGE)]);
            });
          });
          const r = await chat(stream, { tools: TOOLS });
          assert.strictEqual(r.status, 200);
          assert.strictEqual(seen.length, recovery === 'inline' ? 1 : 2);
          const prompt = recovery === 'inline' ? 1 : 10;
          const completion = recovery === 'inline' ? 1 : 13;
          totalPrompt += prompt;
          totalCompletion += completion;
          const usageLogs = logs.filter(line => line.includes(' | token '));
          assert.strictEqual(usageLogs.length, 1, '每次客户端请求只记一次用量');
          assert.ok(usageLogs[0].includes(`token ${prompt}/${completion} `), usageLogs[0]);
          assert.ok(usageLogs[0].includes(`累计 ${totalPrompt}/${totalCompletion}`), usageLogs[0]);
          assert.ok(usageLogs[0].includes('DeepSeek-V4.1-Flash'), '日志标明客户端选择的模型');
        });
      }
    }
    await t.test('聚合路径:空响应触发非流式重发,客户端拿到结构化 tool_calls', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          const sent = JSON.parse(b);
          seen.push({ stream: sent.stream, tools: Array.isArray(sent.tools) });
          if (seen.length === 1) sse(res, EMPTY_TOOL_FRAMES);   // 第一次:被吞
          else jsonCompletion(res, DSML);                        // 第二次:DSML
        });
      });
      const r = await chat(false, { tools: TOOLS });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen.length, 2, '应恰好重发一次');
      assert.strictEqual(seen[0].stream, true, '第一次对上游强制流式');
      assert.strictEqual(seen[1].stream, false, '重发必须是非流式(唯一能拿到 DSML 的形态)');
      const m = r.json.choices?.[0]?.message;
      assert.ok(Array.isArray(m.tool_calls), '客户端应拿到结构化 tool_calls');
      assert.strictEqual(m.tool_calls[0].function.name, 'Bash');
      assert.deepStrictEqual(JSON.parse(m.tool_calls[0].function.arguments), { command: 'Get-Location' });
      assert.strictEqual(r.json.choices[0].finish_reason, 'tool_calls');
    });

    await t.test('流式路径:同样触发补救并以 SSE 形态交付', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          const sent = JSON.parse(b);
          seen.push({ stream: sent.stream });
          if (seen.length === 1) sse(res, EMPTY_TOOL_FRAMES);
          else jsonCompletion(res, DSML);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen.length, 2, '流式路径也应重发');
      assert.strictEqual(seen[1].stream, false);
      const p = streamParts(r.text);
      assert.ok(p.tc, '流式客户端应拿到 tool_calls delta');
      assert.strictEqual(p.tc[0].function.name, 'Bash');
      assert.strictEqual(p.finish, 'tool_calls');
      assert.ok(r.text.includes('[DONE]'), '应以 [DONE] 正常收尾');
    });

    await t.test('不误伤:请求没带 tools 时空响应不触发重发', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => { seen.push(1); sse(res, EMPTY_TOOL_FRAMES); });
      });
      const r = await chat(false); // 不带 tools
      assert.strictEqual(seen.length, 1, '无 tools 的请求不得重发(与工具无关)');
      assert.strictEqual(r.status, 200);
    });

    await t.test('带 tools 且有开场白+调用标记 → 补救(1.10.1:要求正证据)', async () => {
      // 实测:上游流式下会先吐开场白再生成工具调用,而调用部分被上游吞掉。
      // 这种形态必须补救——此时的"正证据"是正文里**出现了调用标记的起始特征**
      // (1.10.1 起不再凭"没有调用"就补救,见下面那条用例)
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          if (seen.length === 1) {
            // 第一次:开场白 + 被截断的调用标记
            sse(res, [
              JSON.stringify({ choices: [{ index: 0, delta: { content: '好的,我来处理。<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">' }, finish_reason: null }] }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
            ]);
          } else {
            jsonCompletion(res, DSML); // 重发:完整 DSML
          }
        });
      });
      const r = await chat(false, { tools: TOOLS });
      assert.strictEqual(seen.length, 2, '有调用标记时应尝试补救');
      const m = r.json.choices?.[0]?.message;
      assert.ok(Array.isArray(m.tool_calls), '应交付结构化 tool_calls');
      assert.strictEqual(r.json.choices[0].finish_reason, 'tool_calls');
    });

    await t.test('带 tools 但只有正常正文(无标记)→ 不补救,恰好 1 次上游请求', async () => {
      // 1.10.1 收紧:模型正常给纯文本回答时,本来就没有工具调用可言。
      // 旧判据("带 tools 且无调用")把这种合法回答也送去重发,导致**每次**带
      // tools 的请求都多打一次上游(实测 5 场景全 2 次),而上游并发上限只有 3,
      // 可用并发直接砍半。用户实测报出,此处钉住"不得重发"
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { content: '这是一句普通回答。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          ]);
        });
      });
      const r = await chat(false, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '纯文本回答不得触发重发(否则每次带 tools 都多打一次上游)');
      assert.strictEqual(r.json.choices?.[0]?.message?.content, '这是一句普通回答。');
      assert.ok(!r.json.choices?.[0]?.message?.tool_calls, '不得伪造调用');
    });

    await t.test('tool_choice:none + 正文含 DSML 字样 → 绝不合成调用(1.10.1)', async () => {
      // 用户实测复现的伪造路径:客户端明确禁止工具调用,而模型正文里只是
      // **提到**了 DSML 格式(讲协议/贴示例),旧实现会把这段说明文解析成真的
      // 工具调用交给客户端执行(实测合成出 `Bash: ls`)。none 下必须完全不补救
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          // 上游忠实遵守 none:只给说明文,不给任何调用
          jsonCompletion(res, '调用形如 <｜DSML｜invoke name="Bash"><｜DSML｜parameter name="command">ls</｜DSML｜parameter></｜DSML｜invoke>,这只是格式说明。');
        });
      });
      const r = await chat(false, { tools: TOOLS, tool_choice: 'none' });
      assert.strictEqual(seen.length, 1, 'tool_choice:none 时不得重发');
      const m = r.json.choices?.[0]?.message;
      assert.ok(!m.tool_calls, '不得把说明文伪造成工具调用');
      assert.strictEqual(r.json.choices[0].finish_reason, 'stop', 'finish_reason 不得被改成 tool_calls');
    });

    await t.test('思维链写满而正文为空 → 不补救,恰好 1 次上游请求(1.10.1)', async () => {
      // 思维链模型的**正常**形态:思考写满 reasoning_content、content 为空、
      // finish=stop。旧判据只看 content,把它误判成"完全空回复"(被吞的签名)
      // 而白打一次上游。审阅实测复现(流式与聚合都中),此处两条路径都钉住
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '用户问天气,我得先想清楚要不要调工具。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          ]);
        });
      });
      const rAgg = await chat(false, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '聚合路径:思维链非空不得触发重发');
      assert.ok(rAgg.json.choices?.[0]?.message?.reasoning_content, '思考链应照常交付');

      seen = [];
      const rStream = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '流式路径:思维链非空不得触发重发');
      assert.ok(rStream.text.includes('reasoning_content'), '流式应照常交付思考链');
    });

    await t.test('tool_choice:none + 空回复 → 仍不重发(闸不依赖内容判据)', async () => {
      // 钉住"闸的位置":none 的拦截必须独立于内容判据生效。若有人把闸挪进
      // 内容分支(如只在"有内容"时拦),这条会红——空回复正好绕开内容判据
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => { seen.push(1); sse(res, EMPTY_TOOL_FRAMES); });
      });
      const r = await chat(true, { tools: TOOLS, tool_choice: 'none' });
      assert.strictEqual(seen.length, 1, 'none + 空回复仍不得重发');
      assert.ok(!/"tool_calls":\s*\[/.test(r.text), '不得伪造调用');
    });

    await t.test('不误伤:上游已给出结构化 tool_calls 时不重发', async () => {
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

    // ---- 流式缓冲的冲刷路径(审阅者的变异实验指出这两条最敏感且当时无用例) ----

    await t.test('流式:命中补救失败时,缓冲帧仍完整交付(不得静默丢帧)', async () => {
      // 变异"缓冲永不冲刷"/"冲刷时丢帧"当时都能全绿——这条钉住冲刷
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          if (seen.length === 1) sse(res, EMPTY_TOOL_FRAMES);   // 触发补救
          else jsonCompletion(res, '这不是工具调用');            // 补救拿不到调用
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 2, '应尝试过重发');
      // 补救未成功:第一次的缓冲帧必须原样交付,客户端不能收到空流
      assert.ok(r.text.includes('[DONE]'), '缓冲帧应被冲刷并以 [DONE] 收尾');
      assert.ok(r.text.includes('data:'), '应有 SSE 帧:' + JSON.stringify(r.text.slice(0, 200)));
    });

    await t.test('流式:纯文本回答(无标记)→ 不补救,1 次请求且原文完整交付', async () => {
      // 1.10.1:帧序"开场白 → stop"而正文里**没有**调用标记时,这是一次合法的
      // 纯文本回答,不该重发(旧行为会多打一次上游)。同时钉住:不重发也意味着
      // 缓冲帧必须正常冲刷,客户端要收到完整原文
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '我来处理:' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          ]);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '纯文本回答不得触发重发');
      const p = streamParts(r.text);
      assert.strictEqual(p.content, '我来处理:', '不重发时原文必须完整交付');
      assert.ok(!p.tc, '不得伪造调用');
      assert.ok(r.text.includes('[DONE]'));
    });

    await t.test('流式:有调用标记但补救拿不到调用 → 原文完整交付', async () => {
      // 有标记(正证据)故应尝试补救;补救给出普通文本时,客户端必须收到原文
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          if (seen.length === 1) {
            sse(res, [
              JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '我来处理:<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">' }, finish_reason: null }] }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
            ]);
          } else jsonCompletion(res, '重发只有普通文本,没有工具调用');
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 2, '有标记应尝试补救');
      const p = streamParts(r.text);
      assert.ok(!p.tc, '不得伪造调用');
      assert.ok(r.text.includes('[DONE]'));
    });

    await t.test('流式:tool_choice:none 时不补救,说明文照常交付', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { content: '格式是 <｜DSML｜invoke name="Bash">,仅说明。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          ]);
        });
      });
      const r = await chat(true, { tools: TOOLS, tool_choice: 'none' });
      assert.strictEqual(seen.length, 1, 'tool_choice:none 时不得重发');
      const p = streamParts(r.text);
      assert.ok(!p.tc, '不得把说明文伪造成工具调用');
      assert.notStrictEqual(p.finish, 'tool_calls', 'finish_reason 不得被改');
    });

    await t.test('流式:finish_reason=length 时不触发补救,缓冲照常交付', async () => {
      // 触发条件要求 finish 为 stop;length 属另一语义(输出被截断),不该补救
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
          ]);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, 'length 收尾不应触发补救');
      assert.ok(r.text.includes('[DONE]'), '缓冲仍须交付');
    });

    await t.test('流式:思考帧即时透传,不等到 finish(带 tools 也不缓冲思考)', async () => {
      // 用户实测(2026-09-29):带 tools 的请求全程缓冲,思考阶段长达几十秒到
      // 几分钟而客户端一个字都收不到,体感等同卡死。修复后 role/reasoning 帧
      // 即时透传,只有 content/tool_calls 帧才扣留。
      // 用带节奏的假上游:思考帧先发,停 400ms 再发 tool_calls。若思考被缓冲,
      // 客户端所有数据会挤在结尾一次到达(首末间隔 <100ms);透传生效则思考帧
      // 比结尾早 300ms 以上到达
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
          seen.push(1);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '先想清楚该调哪个工具。' }, finish_reason: null }] })}\n\n`);
          await new Promise(x => setTimeout(x, 400));
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: 't1', type: 'function', index: 0, function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      // 增量读:记录首块与末块到达时间
      const stamps = [];
      const done = new Promise(resolve => {
        const payload = JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, stream: true });
        const rq = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
          rs => {
            const t0 = Date.now();
            let text = '';
            rs.on('data', c => { stamps.push(Date.now() - t0); text += c; });
            rs.on('end', () => resolve(text));
          });
        rq.on('error', e => resolve('REQ-ERR ' + e.message));
        rq.write(payload);
        rq.end();
      });
      const text = await done;
      assert.strictEqual(seen.length, 1, '应恰好 1 次上游请求(原生 tool_calls 不补救)');
      const first = stamps[0];
      const last = stamps[stamps.length - 1];
      assert.ok(last - first >= 300,
        `思考帧应提前到达:首块 ${first}ms,末块 ${last}ms(间隔过小说明思考被缓冲到结尾)`);
      assert.ok(text.includes('reasoning_content'), '思考内容应交付:' + text.slice(0, 200));
      assert.ok(text.includes('"tool_calls"'), '工具调用应交付');
      assert.ok(text.includes('[DONE]'));
    });

    await t.test('流式:思考已透传(头已发)时,扣留的正文帧在收尾照常补写,不得静默丢弃', async () => {
      // 配套钉住 flushBuffer 的修改:思考帧把 SSE 头带出去后,缓冲里剩下的
      // content/finish 帧若因"头已发出"被守卫丢掉,就是静默丢正文。
      // 场景:思考 + 正常纯文本回答(无标记 → 不补救)→ 客户端必须收到完整正文
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          sse(res, [
            JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '想一想。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: { content: '这是一句普通回答。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          ]);
        });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1, '纯文本回答不得触发重发');
      const p = streamParts(r.text);
      assert.strictEqual(p.content, '这是一句普通回答。', '扣留的正文必须补写,不得因头已发出而丢弃');
      assert.ok(r.text.includes('想一想。'), '思考帧应已透传');
      assert.ok(r.text.includes('[DONE]'));
    });

    await t.test('不伪造:重发拿到的文本解析不出工具调用时按原样交付', async () => {
      seen = [];
      mock.set((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
          seen.push(1);
          if (seen.length === 1) sse(res, EMPTY_TOOL_FRAMES);
          else jsonCompletion(res, '这不是工具调用,只是普通的一句话。');
        });
      });
      const r = await chat(false, { tools: TOOLS });
      assert.strictEqual(seen.length, 2, '应尝试重发');
      assert.strictEqual(r.status, 200);
      const m = r.json.choices?.[0]?.message;
      assert.ok(!m.tool_calls, '解析不出时绝不得伪造 tool_calls');
    });

    await t.test('开关关闭(PROXY_TOOL_FIX=0)时恢复纯透传', async () => {
      // config 已冻结,直接断言读取口径(默认开;仅 "0" 关闭),不改运行中实例
      assert.strictEqual(config.toolCallFix, true, '默认应为开');
      const load = require.resolve('../config');
      const prev = process.env.PROXY_TOOL_FIX;
      process.env.PROXY_TOOL_FIX = '0';
      delete require.cache[load];
      const off = require('../config');
      assert.strictEqual(off.toolCallFix, false, '=0 应关闭');
      if (prev === undefined) delete process.env.PROXY_TOOL_FIX; else process.env.PROXY_TOOL_FIX = prev;
      delete require.cache[load];
    });
    await t.test('混合帧恢复工具调用时保留思考、usage 和结束顺序', async () => {
      seen = [];
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push(1);
          sse(res, [JSON.stringify({ choices: [{ index: 0,
            delta: { content: DSML, reasoning: '先检查路径。' }, finish_reason: null }] }),
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
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

    await t.test('流式请求收到完整 JSON 不会被误当空流再发一次', async () => {
      seen = [];
      mock.set((req, res) => {
        req.resume();
        req.on('end', () => { seen.push(1); jsonCompletion(res, '正常回答'); });
      });
      const r = await chat(true, { tools: TOOLS });
      assert.strictEqual(seen.length, 1);
      assert.ok(r.text.includes('正常回答'));
    });

  } finally {
    await new Promise(r => httpServer.server.close(r));
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) {}
  }
});
