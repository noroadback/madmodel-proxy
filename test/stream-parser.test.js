// test/stream-parser.test.js — SSE 解析(纯函数):chunk 边界、跨 chunk UTF-8、
// 空帧容忍、[DONE] 终止态、坏帧、单行上限。
// 2026-09-05 事故的教训归 this 文件守护:空心跳帧必须容忍,未知帧型交给真实流量
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SseParser } = require('../core/stream-parser');

test('解析: 基本 data 帧出 JSON 事件', () => {
  const p = new SseParser(1024);
  const ev = p.push('data: {"a":1}\n\n');
  assert.deepStrictEqual(ev, [{ type: 'data', value: { a: 1 } }]);
});

test('解析: [DONE] 出终止事件,此后任何输入不再产生事件', () => {
  const p = new SseParser(1024);
  assert.deepStrictEqual(p.push('data: [DONE]\n'), [{ type: 'done' }]);
  assert.deepStrictEqual(p.push('data: {"late":1}\n'), []);
  assert.deepStrictEqual(p.push(Buffer.from('garbage')), []);
});

test('解析: 空 data 帧容忍不报错(2026-09-05 网关心跳帧形态)', () => {
  const p = new SseParser(1024);
  const ev = p.push('data: \ndata:\n\ndata: {"ok":1}\n');
  assert.deepStrictEqual(ev, [{ type: 'data', value: { ok: 1 } }]);
});

test('解析: CRLF 行尾与 "data:" 无空格形态', () => {
  const p = new SseParser(1024);
  const ev = p.push('data:{"a":2}\r\n');
  assert.deepStrictEqual(ev, [{ type: 'data', value: { a: 2 } }]);
});

test('解析: 非 data 行(id:/event:/注释/空行)忽略', () => {
  const p = new SseParser(1024);
  const ev = p.push('id: 12\nevent: x\n:comment\n\ndata: {"a":3}\n');
  assert.deepStrictEqual(ev, [{ type: 'data', value: { a: 3 } }]);
});

test('解析: 行在 chunk 边界切开仍拼成完整帧', () => {
  const p = new SseParser(1024);
  assert.deepStrictEqual(p.push('data: {"a":'), []);
  assert.deepStrictEqual(p.push('4}\n'), [{ type: 'data', value: { a: 4 } }]);
});

test('解析: 多字节 UTF-8 字符跨 chunk 切开正确拼帧(TextDecoder 流模式)', () => {
  const p = new SseParser(1024);
  const full = Buffer.from('data: {"t":"你好世界"}\n', 'utf8');
  // 从多字节字符中间切开:好 = E4 BD A0
  const cut = full.indexOf(Buffer.from('好', 'utf8')) + 1;
  assert.deepStrictEqual(p.push(full.subarray(0, cut)), []);
  const ev = p.push(full.subarray(cut));
  assert.deepStrictEqual(ev, [{ type: 'data', value: { t: '你好世界' } }]);
});

test('解析: 坏 JSON 出 invalid 事件而非抛出', () => {
  const p = new SseParser(1024);
  const ev = p.push('data: {broken\n');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'invalid');
  assert.ok(ev[0].message.includes('坏帧'));
});

test('解析: 无换行缓冲超过 lineLimit 出 invalid 并清缓冲', () => {
  const p = new SseParser(16);
  const ev = p.push('data: ' + 'x'.repeat(40));
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'invalid');
  assert.ok(ev[0].message.includes('单行超过'));
  // 缓冲已清:后续合法帧正常解析
  assert.deepStrictEqual(p.push('data: {"a":5}\n'), [{ type: 'data', value: { a: 5 } }]);
});

test('解析: 一次 push 多帧按序产出', () => {
  const p = new SseParser(1024);
  const ev = p.push('data: {"n":1}\ndata: {"n":2}\ndata: [DONE]\ndata: {"n":3}\n');
  assert.deepStrictEqual(ev, [
    { type: 'data', value: { n: 1 } },
    { type: 'data', value: { n: 2 } },
    { type: 'done' },
  ]);
});
