// test/tokenizer.test.js — 本地分词器与上游逐 token 一致性的回归钉。
// 所有关键值来自 2026-09-10 oracle 校准(上游 usage.prompt_tokens 直测):
// 单消息 content+模板开销逐 case 精确;多轮与工具结构按保守模型恒 ≥ oracle
// (预检门的安全方向是高估——提前收缩可接受,漏放会被上游拒)。上游换
// 分词器/改模板时这些断言会红,以 usage.prompt_tokens 重新对测校准。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getTokenizer } = require('../core/tokenizer');

const tk = getTokenizer();

// ---- countText:内容分词,值 = oracle prompt_tokens − 单消息模板开销 4 ----
test('分词: 纯中文(oracle 13−4)', () => {
  assert.strictEqual(tk.countText('回复单个字母 a 即可,不要解释'), 9);
});

test('分词: 纯英文(oracle 17−4)', () => {
  assert.strictEqual(tk.countText('Reply with just the letter a. No explanation needed at all.'), 13);
});

test('分词: 中英混合(oracle 32−4)', () => {
  assert.strictEqual(tk.countText('这个 proxy 项目 name is madmodel-proxy,版本 1.5.2,发布于 2026-09-10。'), 28);
});

test('分词: 代码密集(oracle 50−4)', () => {
  assert.strictEqual(tk.countText('const n1234567890 = 987654321 * 1357902468; // x0123456789abcdef\nif (n > 0x1f) { console.log(`ok${n}`); }'), 46);
});

test('分词: 数字串(oracle 28−4)', () => {
  assert.strictEqual(tk.countText('12345678901234567890 3.14159265358979 100% 0xdeadbeef'), 24);
});

test('分词: 长英文 50 句(oracle 507−4)', () => {
  assert.strictEqual(tk.countText('The quick brown fox jumps over the lazy dog. '.repeat(50) + 'Reply a.'), 503);
});

test('分词: 长中文 50 句(oracle 507−4)', () => {
  assert.strictEqual(tk.countText('清华大学的同学们正在开发一个本地代理工具。'.repeat(50) + '回复 a。'), 503);
});

// ---- countPromptTokens:与 oracle 总值直接比对 ----
test('prompt 计量: 单消息各形态与 oracle 逐个相等', () => {
  const cases = [
    ['回复单个字母 a 即可,不要解释', 13],
    ['Reply with just the letter a. No explanation needed at all.', 17],
    ['这个 proxy 项目 name is madmodel-proxy,版本 1.5.2,发布于 2026-09-10。', 32],
    ['const n1234567890 = 987654321 * 1357902468; // x0123456789abcdef\nif (n > 0x1f) { console.log(`ok${n}`); }', 50],
    ['12345678901234567890 3.14159265358979 100% 0xdeadbeef', 28],
    ['The quick brown fox jumps over the lazy dog. '.repeat(50) + 'Reply a.', 507],
    ['清华大学的同学们正在开发一个本地代理工具。'.repeat(50) + '回复 a。', 507],
  ];
  for (const [content, oracle] of cases) {
    assert.strictEqual(tk.countPromptTokens({ messages: [{ role: 'user', content }] }), oracle);
  }
});

test('prompt 计量: 空内容单消息 = 模板开销 4(oracle 实测)', () => {
  assert.strictEqual(tk.countPromptTokens({ messages: [{ role: 'user', content: '' }] }), 4);
});

test('prompt 计量: system 前置不额外计(oracle [s,u]=4 开销同 [u])', () => {
  const v = tk.countPromptTokens({ messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: '回答一个字母即可' },
  ] });
  // oracle 实测 [s,u]=12:content 8 + 开销 4;本地公式恒高估 0~2
  assert.ok(v === 12 || v === 13 || v === 14, `got ${v}`);
});

test('prompt 计量: 多轮高估 ≤2(oracle [s,u,a,u]=33,本地 35)', () => {
  const v = tk.countPromptTokens({ messages: [
    { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你的吗？' },
    { role: 'user', content: '再次回复 a 即可' },
  ] });
  assert.strictEqual(v, 35); // oracle 33,公式保守 +2
});

// ---- 工具结构:oracle 校准过的钉值 ----
test('prompt 计量: tool_call+结果结构与 oracle 相等(79)', () => {
  const v = tk.countPromptTokens({ messages: [
    { role: 'user', content: '看下当前目录' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'bash', arguments: '{"cmd":"dir"}' } }] },
    { role: 'tool', tool_call_id: 'call_abc123', content: ' Volume in drive C is Windows\n Directory of C:\\Users' },
    { role: 'user', content: '目录里有啥,一句话' },
  ] });
  assert.strictEqual(v, 79);
});

test('prompt 计量: tools 定义区保守 ≥ oracle', () => {
  const tool1 = { type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } };
  const tool2 = { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
  const one = tk.countPromptTokens({ messages: [{ role: 'user', content: '回复 a' }], tools: [tool1] });
  const two = tk.countPromptTokens({ messages: [{ role: 'user', content: '回复 a' }], tools: [tool1, tool2] });
  assert.ok(one >= 277, `1 个 tool ${one} < oracle 277`);
  assert.ok(two >= 319, `2 个 tool ${two} < oracle 319`);
});

test('prompt 计量: content 分段数组只计文本段', () => {
  const v = tk.countPromptTokens({ messages: [{ role: 'user', content: [
    { type: 'text', text: '你好' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: '回复 a' },
  ] }] });
  const flat = tk.countPromptTokens({ messages: [{ role: 'user', content: '你好回复 a' }] });
  // 分段间各自计,与拼接文本的差在分段边界 token 化差异内(±2)
  assert.ok(Math.abs(v - flat) <= 2, `${v} vs ${flat}`);
});

test('分词: 同文本重复计数一致(缓存路径)', () => {
  const t = '缓存一致性检查'.repeat(10);
  assert.strictEqual(tk.countText(t), tk.countText(t));
});
