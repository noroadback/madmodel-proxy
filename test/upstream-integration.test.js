// test/upstream-integration.test.js — 经完整 HTTP 服务链的上游错误判定集成测试。
// 本地 mock 上游 + 真实代理实例(装配同 proxy.js,PROXY_UPSTREAM/PROXY_TOKEN_FILE
// 注入),验证 C3 的错误统一矩阵:非 2xx、200-SSE 内嵌标准 error 对象、学校
// errorMessage 帧、302 会话失效、截断、正常完成——错误不得以 200 + 空内容
// 的假成功形态交付。此骨架同时是 Wave 4(A1 等待重试)的测试基座。
// 结构注:装配/收尾用单顶层 test + t.test 子测试 + try/finally,不用顶层
// before/after 钩子——Node 18 的 node:test 根级钩子不生效(18.14.2 CI 实测,
// 测试带着未初始化的装配直接开跑),t.test 子测试全版本可靠
'use strict';
require('../scripts/isolated-env').isolate();

// 环境注入必须在 require config/paths 之前(加载期读取)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-it-'));
process.env.MADMODEL_STATE_DIR = STATE_DIR;
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'it-test-token', expiresAt: Date.now() + 3600e3 }));
process.env.PROXY_TOKEN_FILE = TOKEN_FILE;
// A1 等待重试的预算压到 2s(测试时限;默认 30s 见 config.waitRetryBudgetMs)。
// MADMODEL_FORCE_TUNNEL_MODE:mock 上游不是隧道前缀,但等待重试路径按
// 隧道形态验证(生产中该路径只在默认隧道上游下可达)
process.env.PROXY_RETRY_WAIT_MS = '2000';
process.env.MADMODEL_FORCE_TUNNEL_MODE = '1';
// 空闲守卫压到 1.2s(默认值见 config.streamIdleTimeout):R3 的背压回归
// 用例要靠"停读时长 > 阈值"来验证守卫不把背压静默计入上游空闲,1.2s 让
// 用例秒级完成。其余用例的替身上游都是即时应答,不受此阈值影响
process.env.PROXY_IDLE_MS = '1200';

const test = require('node:test');
const assert = require('node:assert');

// ---- mock 上游(可编程响应) ----
function startMockUpstream() {
  let handler = null;
  const server = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 未配置 handler' } }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      set: h => { handler = h; },
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

// mock 上游的 SSE 应答助手
function sse(res, frames, { status = 200 } = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const CH = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' } }] };
const USAGE = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };

test('上游错误判定集成矩阵(mock 上游 + 完整代理实例)', async t => {
  // ---- 装配(同 proxy.js,PROXY_UPSTREAM 指向 mock) ----
  const mock = await startMockUpstream();
  const port = await freePort();
  process.env.PROXY_UPSTREAM = `http://127.0.0.1:${mock.port}/v1/chat/completions`;
  process.env.PROXY_PORT = String(port);
  const config = require('../config');
  const { createUpstreamClient } = require('../core/upstream-client');
  const { createProxyService } = require('../core/proxy-service');
  const { createHttpServer, createTokenCache, createTokenState } = require('../adapters/http-server');
  const getToken = createTokenCache(config);
  const tokenState = createTokenState(getToken);
  const { createCredentialWaiter } = require('../adapters/http-server');
  const service = createProxyService({
    config, tokenState, upstreamClient: createUpstreamClient(config),
    waitForCredentials: createCredentialWaiter(getToken),
  });
  const httpServer = createHttpServer({ config, service, getToken });
  await new Promise(res => httpServer.server.listen(port, '127.0.0.1', res));
  const proxyUrl = `http://127.0.0.1:${port}/v1/chat/completions`;

  // 客户端视角的调用;返回 { status, json, text }
  const chat = async (stream, extra = {}) => {
    const r = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'DeepSeek-V4-Flash-0731',
        messages: [{ role: 'user', content: '回复ok' }],
        max_tokens: 512,
        stream, ...extra,
      }),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* SSE 文本 */ }
    return { status: r.status, json, text };
  };

  try {
    await t.test('流式与非流式的完成日志显示首字等待和均速', async () => {
      const lines = [];
      const originalLog = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try {
        for (const stream of [true, false]) {
          mock.set((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
            setTimeout(() => {
              res.end(`data: ${JSON.stringify(CH)}\n\ndata: ${JSON.stringify(USAGE)}\n\ndata: [DONE]\n\n`);
            }, 20);
          });
          assert.strictEqual((await chat(stream)).status, 200);
        }
      } finally { console.log = originalLog; }
      const completed = lines.filter(line => line.includes('token 1/1'));
      assert.strictEqual(completed.length, 2);
      for (const line of completed) {
        assert.match(line, /首字 \d+\.\ds/);
        assert.match(line, /均速 \d+\.\d tok\/s/);
      }
    });

    await t.test('双思考字段经工具流缓冲与非流式交付后均不重复', async () => {
      const { createAggregator } = require('../core/completion-aggregator');
      for (const stream of [true, false]) {
        mock.set((req, res) => sse(res, [
          JSON.stringify({ choices: [{ index: 0, delta: { reasoning: '先想', reasoning_content: '先想' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: { reasoning: '再想', reasoning_content: '再想', content: '答案' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ]));
        const r = await chat(stream, { model: 'DeepSeek-V4.1-Flash', tools: [{ type: 'function',
          function: { name: 'read', parameters: { type: 'object', properties: {} } } }] });
        assert.strictEqual(r.status, 200);
        let result = r.json;
        if (stream) {
          const agg = createAggregator();
          for (const line of r.text.split('\n')) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') agg.feed(JSON.parse(line.slice(6)));
          }
          assert.ok(r.text.includes('[DONE]'));
          result = agg.result();
        }
        assert.strictEqual(result.choices[0].message.reasoning_content, '先想再想');
        assert.strictEqual(result.choices[0].message.content, '答案');
      }
    });

    await t.test('正常流式: 200 SSE 透传,内容与 [DONE] 完整', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]));
      const r = await chat(true);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('"content":"ok"'));
      assert.ok(r.text.includes('[DONE]'));
    });

    await t.test('正常非流式: 200 SSE 聚合为 completion', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]));
      const r = await chat(false);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.choices?.[0]?.message?.content, 'ok');
    });

    // ---- 含图请求透传(1.9.2 的本地预检已移除:目标模型支持视觉,不再拦) ----
    await t.test('含 image_url 的会话历史照常转发上游(本地不再拦截)', async () => {
      let upstreamHits = 0;
      mock.set((req, res) => { upstreamHits++; sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]); });
      const r = await chat(false, { messages: [
        { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      ] });
      assert.strictEqual(r.status, 200, '含图请求应透传,不再本地 400');
      assert.strictEqual(upstreamHits, 1, '含图请求应到达上游');
    });

    await t.test('纯文本与纯 text 段的 content 数组照常放行', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]));
      const a = await chat(false, { messages: [{ role: 'user', content: '纯文本' }] });
      assert.strictEqual(a.status, 200);
      const b = await chat(false, { messages: [{ role: 'user', content: [{ type: 'text', text: '纯文本段' }] }] });
      assert.strictEqual(b.status, 200);
    });

    await t.test('非 2xx + SSE content-type + 标准 error 对象: 不得成为 200 假成功', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ error: { message: 'busy', type: 'server_error' } })], { status: 500 }));
      const r = await chat(false);
      assert.notStrictEqual(r.status, 200);
      assert.strictEqual(r.json.error.code, 502);
      assert.ok(r.json.error.message.includes('busy'));
    });

    await t.test('真实 HTTP 400 上下文错误回放: 两种客户端模式均返回标准超限错误', async () => {
      // 2026-10-15 直连上游实测的两种校验路径，原文只含合成样本的数量。
      const messages = [
        "This model's maximum context length is 1048576 tokens. However, you requested 1048576 output tokens and your prompt contains 89 characters (more than 0 characters, which is the upper bound for 0 input tokens). Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_text, value=89)",
        "This model's maximum context length is 1048576 tokens. However, you requested 1047552 output tokens and your prompt contains at least 1025 input tokens, for a total of at least 1048577 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=1025)",
        "This model's maximum context length is 262144 tokens. However, you requested 262144 output tokens and your prompt contains 108 characters (more than 0 characters, which is the upper bound for 0 input tokens). Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_text, value=108)",
      ];
      for (const message of messages) {
        for (const stream of [true, false]) {
          let hits = 0;
          mock.set((req, res) => {
            hits++;
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message, type: 'BadRequestError',
              param: message.includes('parameter=input_tokens') ? 'input_tokens' : 'input_text', code: 400 } }));
          });
          const r = await chat(stream);
          assert.strictEqual(r.status, 400);
          assert.strictEqual(r.json.error.type, 'invalid_request_error');
          assert.strictEqual(r.json.error.code, 'context_length_exceeded');
          assert.ok(r.json.error.message.includes(message));
          assert.strictEqual(hits, 1, '明确参数错误不应触发重试');
        }
      }
    });

    await t.test('HTTP 400 max_tokens 参数错误: 保留 400 与原文，不误报上下文超限', async () => {
      for (const stream of [true, false]) {
        const message = 'max_tokens must be greater than 0';
        mock.set((req, res) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message, type: 'BadRequestError', param: 'max_tokens', code: 400 } }));
        });
        const r = await chat(stream);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json.error.type, 'invalid_request_error');
        assert.strictEqual(r.json.error.code, 400);
        assert.ok(r.json.error.message.includes(message));
      }
    });

    await t.test('200 SSE 内嵌标准上下文错误: 两种客户端模式均传递 type 和 code', async () => {
      for (const stream of [true, false]) {
        mock.set((req, res) => sse(res, [JSON.stringify({ error: {
          message: 'context overflow', type: 'invalid_request_error', code: 'context_length_exceeded',
        } })]));
        const r = await chat(stream);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json.error.type, 'invalid_request_error');
        assert.strictEqual(r.json.error.code, 'context_length_exceeded');
        assert.ok(r.json.error.message.includes('context overflow'));
      }
    });

    await t.test('200 SSE 内嵌标准 error 对象帧: 翻译为 5xx 错误,不进聚合', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ error: { message: 'quota exceeded' } })]));
      const r = await chat(false);
      assert.notStrictEqual(r.status, 200);
      assert.ok(r.json.error.message.includes('quota exceeded'));
    });

    await t.test('200 SSE 内嵌学校 errorMessage 帧: 429 繁忙语义(既有行为钉住)', async () => {
      mock.set((req, res) => sse(res, [JSON.stringify({ errorMessage: '服务器繁忙，请稍后再试' })]));
      const r = await chat(false);
      assert.strictEqual(r.status, 429);
      assert.ok(r.json.error.message.includes('服务器繁忙'));
    });

    await t.test('302 空响应体: 明确的会话失效文案,非"无法识别的响应"', async () => {
      mock.set((req, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('WebVPN 会话已失效'), r.json.error.message);
    });

    await t.test('404: 端点变更文案(既有行为钉住)', async () => {
      mock.set((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>404</html>'); });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('端点可能已变更'));
    });

    await t.test('200 SSE 中途截断(无 [DONE]): 非流式 502 截断文案', async () => {
      mock.set((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(CH)}\n\n`);
        res.end(); // 未见 [DONE] 即断
      });
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('截断'));
    });

    // ---- R2(1.9.2):截断文案带"距上一帧时长"。upstream-client 记 idleMs
    // (距上一帧收到字节的时长),经 mapResult 进 message 与日志 ----
    await t.test('R2: 中途截断的文案带"距上一帧 Ns"(idleMs 真实来自静默时长)', async () => {
      mock.set((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(CH)}\n\n`);
        setTimeout(() => res.end(), 700); // 700ms 静默后断流(未发 [DONE])
      });
      const t0 = Date.now();
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('距上一帧 1s'), r.json.error.message);
      // 700ms 静默远未达网关 60s 墙:连接中断形态,不归因网关(归因边界见 errors.js)
      assert.ok(r.json.error.message.includes('连接中断'), r.json.error.message);
      assert.ok(!r.json.error.message.includes('网关'), r.json.error.message);
      assert.ok(r.json.error.message.includes('重试'), r.json.error.message);
      assert.ok(Date.now() - t0 >= 700, '文案里的时长应来自真实等待');
    });

    // ---- R3 回归(1.9.2):客户端背压不得被计入上游空闲。修复前守卫在
    // PROXY_IDLE_MS 处掐掉健康流(客户端收不到 [DONE],日志记 idle-timeout),
    // 复现记录见任务书 R3;此处用真实 TCP 停读制造背压 ----
    await t.test('R3 回归: 客户端停读(背压)超过空闲阈值 → 不掐流,完整交付 [DONE]', async () => {
      mock.set((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let n = 0;
        const frame = () => {
          if (res.destroyed) return;
          if (n >= 400) { res.write('data: [DONE]\n\n'); res.end(); return; }
          n++;
          const obj = { ...CH, choices: [{ index: 0, delta: { content: 'x'.repeat(16000) } }] };
          if (res.write(`data: ${JSON.stringify(obj)}\n\n`)) frame();
          else res.once('drain', frame); // 上游自身也守背压:代理停读则暂停出帧
        };
        frame();
      });
      const out = await new Promise(resolve => {
        const body = JSON.stringify({
          model: 'DeepSeek-V4-Flash-0731',
          messages: [{ role: 'user', content: '回复ok' }],
          max_tokens: 512, stream: true,
        });
        let total = 0, paused = false, sawDone = false;
        const rq = http.request({
          host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, rs => {
          rs.on('data', c => {
            total += c.length;
            if (c.includes('[DONE]')) sawDone = true;
            if (!paused && total > 200000) { // 已收足够多 → 停读 2.5s(> 2× 阈值)
              paused = true;
              rs.pause();
              setTimeout(() => rs.resume(), 2500);
            }
          });
          const done = () => resolve({ total, paused, sawDone });
          rs.on('end', done);
          rs.on('close', done);
        });
        rq.on('error', e => resolve({ total, paused, sawDone, error: String(e.message) }));
        rq.end(body);
      });
      assert.strictEqual(out.error, undefined, String(out.error));
      assert.ok(out.paused, '用例前提:客户端确实停读过(制造了背压)');
      assert.ok(out.sawDone, '流应正常结束([DONE]),而不是被空闲守卫掐断');
      assert.ok(out.total > 6e6, `应收到全部 400 帧,实际 ${out.total} 字节`);
    });

    // ---- A1 等待重试(确认的 WebVPN 会话失效 → 等重签 → 重试一次) ----
    // 模拟"重签":测试中途原子替换 token 文件(与 watch 重签同形态)
    const swapToken = (token, cookie) => {
      const tmp = TOKEN_FILE + '.swap.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ token, cookie, expiresAt: Date.now() + 3600e3 }));
      fs.renameSync(tmp, TOKEN_FILE);
    };

    await t.test('A1 重试: 首次 302 + 凭据更换 → 重试成功,客户端无感', async () => {
      const seenAuth = [];
      mock.set((req, res) => {
        seenAuth.push(req.headers.authorization);
        if (seenAuth.length === 1) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]);
      });
      const p = chat(false); // 发起后 ~600ms 模拟 watch 重签完成
      await new Promise(r => setTimeout(r, 600));
      swapToken('it-test-token-2');
      const r = await p;
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.choices?.[0]?.message?.content, 'ok');
      assert.strictEqual(seenAuth.length, 2, '应恰好两次上游请求');
      assert.ok(seenAuth[1].includes('it-test-token-2'), '重试应携带新凭据');
    });

    await t.test('A1 指纹: token 不变仅 cookie 更新 → 组合指纹仍视为变化并重试', async () => {
      // 前一用例结束后 token 是 it-test-token-2:此用例保持该 token、只换 cookie,
      // 真正走到"单比 token 不够、组合才够"的分支
      let n = 0;
      mock.set((req, res) => {
        n++;
        if (n === 1) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        sse(res, [JSON.stringify(CH), JSON.stringify(USAGE)]);
      });
      const p = chat(false);
      await new Promise(r => setTimeout(r, 600));
      swapToken('it-test-token-2', 'cookie-only-change');
      const r = await p;
      assert.strictEqual(r.status, 200);
    });

    await t.test('A1 上限: 连续两次 302 → 停止重试,交付"凭据仍被拒"文案', async () => {
      mock.set((req, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
      const p = chat(false);
      await new Promise(r => setTimeout(r, 600));
      swapToken('it-test-token-4');
      const r = await p;
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('仍被拒绝'), r.json.error.message);
    });

    await t.test('A1 超时: 等待预算内未见新凭据 → 交付等待预算文案(2s 预算)', async () => {
      mock.set((req, res) => { res.writeHead(302, { location: '/login' }); res.end(); });
      const t0 = Date.now();
      const r = await chat(false);
      assert.strictEqual(r.status, 502);
      assert.ok(r.json.error.message.includes('2s 内未完成续期'), r.json.error.message);
      assert.ok(Date.now() - t0 >= 1800, `应在预算附近返回,实际 ${Date.now() - t0}ms`);
    });
  } finally {
    await new Promise(r => httpServer.server.close(r));
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
  }
});
