'use strict';
require('../scripts/isolated-env').isolate();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { WireAudit, failureDiagnosticNote } = require('../core/failure-diagnostics');
const { createUpstreamClient } = require('../core/upstream-client');
const { listenTestHttp } = require('../scripts/listen-test-http');
const { appendDiagnostic } = require('../platform/diagnostic-store');
const base = require('../config');
const config = { ...base, diagnosticsEnabled: true, tunnelMode: false,
  upstream: 'http://127.0.0.1:1/completions', upstreamHeaderTimeout: 1000,
  streamIdleTimeout: 1000, streamTotalTimeout: 3000 };
const payload = { model: 'DeepSeek-V4.1-Flash', stream: true,
  messages: [{ role: 'user', content: 'private-prompt' }] };
const frame = (args, first = false, finish = null) => 'data: ' + JSON.stringify({
  choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: 'c', type: 'function' } : {}),
    function: { ...(first ? { name: 'private-tool' } : {}), arguments: args } }] }, finish_reason: finish }],
}) + '\n\n';

function testConfig(t) {
  const dir = fs.mkdtempSync(path.join(path.dirname(base.tokenFile), 'diagnostic-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...config, tokenFile: path.join(dir, 'token.json') };
}

test('原始参数独立摘要跨字节和代理项边界一致，不缓存完整参数', () => {
  const pieces = ['{"text":"私密', '\ud83d', '\ude00', '"}'];
  const bytes = Buffer.from(pieces.map((part, i) => frame(part, i === 0, i === 3 ? 'tool_calls' : null)).join('') + 'data: [DONE]\n\n');
  const audit = new WireAudit(4096);
  for (const byte of bytes) audit.push(Buffer.from([byte]));
  const out = audit.snapshot();
  assert.equal(out.complete, true);
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.tools[0].fragments, pieces.length);
  assert.equal(out.tools[0].hash, createHash('sha256').update(pieces.join(''), 'utf16le').digest('hex'));
  assert.ok(!JSON.stringify(audit).includes('私密'));
});

test('独立取证对非标准帧、损坏编码及缺失 DONE 降低置信度，不伪称一致', () => {
  for (const wire of [Buffer.from('data: {"a":1}\ndata: {"b":2}\n\n'),
    Buffer.from([0xff]), Buffer.from(frame('{"secret":"', true))]) {
    const audit = new WireAudit(2048); audit.push(wire); audit.end();
    assert.equal(audit.snapshot().complete, false);
  }
  const audit = new WireAudit(2048);
  audit.push(Buffer.from('data: [DONE]\nevent: error\n\n'));
  assert.equal(audit.snapshot().sawDone, false);
});

test('工具已声明但省略参数时保留零片段，不能误判为代理丢失', () => {
  const audit = new WireAudit(2048);
  audit.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f"}}]}}]}\n\ndata: [DONE]\n\n'));
  const out = audit.snapshot();
  assert.equal(out.complete, true);
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].chars, 0);
  assert.equal(out.tools[0].fragments, 0);
  assert.equal(out.tools[0].hash, createHash('sha256').update('', 'utf16le').digest('hex'));
});

test('上游背压超时和最终交付超时记为 delivery，区分上游与总时长', t => {
  const cfg = testConfig(t);
  const common = { requestId: 'test-id', startedAt: performance.now() - 500, elapsedMs: 100,
    network: { observed: true, bodySent: true, headersReceived: true }, wire: null };
  const backpressure = { type: 'timeout', phase: 'total', diagnostics: { ...common, phase: 'delivery' } };
  const finalDelivery = { type: 'completion', diagnostics: { ...common, phase: 'response-body' } };
  failureDiagnosticNote(cfg, backpressure);
  failureDiagnosticNote(cfg, finalDelivery, { kind: 'delivery-timeout' });
  const records = fs.readFileSync(path.join(path.dirname(cfg.tokenFile), 'failure-diagnostics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const record of records) {
    assert.equal(record.networkStage, 'delivery');
    assert.equal(record.upstreamElapsedMs, 100);
    assert.ok(record.elapsedMs >= 500);
  }
  assert.equal(records[1].phase, 'delivery');
});

test('无效参数原样接收可以定位到上游响应，文件不含参数、hash、凭据或 URL', async t => {
  const cfg = testConfig(t);
  const args = '{"command":"private-command-without-closing-quote';
  const wire = frame(args, true, 'length') + 'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
  let parsed = '';
  const result = await createUpstreamClient(cfg).request({ payload, token: 'private-token',
    onChunk(obj) { parsed += obj.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments || ''; } });
  assert.equal(result.type, 'stream');
  const details = { kind: 'invalid-tool-call', toolArguments: [{ index: 0, arguments: parsed }] };
  assert.match(failureDiagnosticNote(cfg, result, details), /原始参数=一致.*DONE=已见/);
  failureDiagnosticNote(cfg, result, details);
  const text = fs.readFileSync(path.join(path.dirname(cfg.tokenFile), 'failure-diagnostics.jsonl'), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1, '同一失败只保存一次');
  const record = JSON.parse(lines[0]);
  assert.equal(record.argumentComparison, 'match');
  assert.equal(record.wire.finishReason, 'length');
  assert.equal(record.wire.sawDone, true);
  assert.equal(record.networkStage, 'unobserved', 'mock fetch 不制造发送确认');
  assert.ok(!/private-|https?:|hash/.test(text));
});

test('模拟代理解析后改写参数，独立原始摘要能检测不一致', async t => {
  const cfg = testConfig(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(frame('{"value":1}', true, 'tool_calls') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }));
  let changed;
  const result = await createUpstreamClient(cfg).request({ payload, token: 'fake', onChunk(obj) {
    const call = obj.choices?.[0]?.delta?.tool_calls?.[0];
    if (call) changed = call.function.arguments = '{"value":2}';
  } });
  assert.match(failureDiagnosticNote(cfg, result, { kind: 'invalid-tool-call', toolArguments: [{ index: 0, arguments: changed }] }), /原始参数=不一致/);
});

test('JSON 备用响应独立摘要也支持工具参数对照', async t => {
  const cfg = testConfig(t), args = '{"private":"unfinished';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{
    finish_reason: 'length', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: args } }] },
  }] }), { headers: { 'content-type': 'application/json' } }));
  const result = await createUpstreamClient(cfg).request({ payload, token: 'fake' });
  assert.equal(result.type, 'completion');
  assert.match(failureDiagnosticNote(cfg, result, { toolArguments: [{ index: 0, arguments: args }] }), /原始参数=一致/);
});

test('真实并发请求的发送时序独立关联，关闭取证时不新增结果字段', async t => {
  const cfg = testConfig(t);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); });
  });
  await listenTestHttp(server);
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const upstream = `http://127.0.0.1:${server.address().port}/completions`;
  const client = createUpstreamClient({ ...cfg, upstream });
  const results = await Promise.all([1, 2].map(() => client.request({ payload, token: 'fake' })));
  assert.notEqual(results[0].diagnostics.requestId, results[1].diagnostics.requestId);
  for (const result of results) {
    assert.equal(result.diagnostics.network.observed, true);
    assert.equal(result.diagnostics.network.bodySent, true);
    assert.equal(result.diagnostics.network.headersReceived, true);
    assert.ok(result.diagnostics.network.headersMs >= result.diagnostics.network.createdMs);
  }
  const disabled = await createUpstreamClient({ ...cfg, upstream, diagnosticsEnabled: false }).request({ payload, token: 'fake' });
  assert.equal(disabled.diagnostics, undefined);
});

test('失败诊断只保留有限历史，写入失败不影响请求', t => {
  const cfg = testConfig(t), file = path.join(path.dirname(cfg.tokenFile), 'failure-diagnostics.jsonl');
  fs.writeFileSync(file, 'x'.repeat(1048570));
  assert.equal(appendDiagnostic(cfg.tokenFile, { kind: 'network-error' }), true);
  assert.equal(fs.statSync(file + '.previous').size, 1048570);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { kind: 'network-error' });
  assert.equal(appendDiagnostic(null, {}), false);
  const failed = { type: 'network-error', diagnostics: { requestId: 'store-failed', elapsedMs: 1,
    network: { observed: false, bodySent: false, headersReceived: false }, wire: null } };
  for (let index = 0; index < 2; index++) {
    assert.match(failureDiagnosticNote({ ...cfg, tokenFile: null }, failed), /诊断保存失败/);
  }
});
