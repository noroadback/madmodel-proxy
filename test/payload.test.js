// test/payload.test.js — 请求解析与归一化(纯函数)。
// 与真实流量冒烟的分工:这里只测纯逻辑边界,协议行为靠 smoke-real.js
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const { parseJsonBody, normalizePayload, fitTokenBudget, estimatePromptBudget,
  CONTEXT_RESERVE_TOKENS } = require('../core/payload');

const MODEL = 'DeepSeek-V4-Flash-0731';

// ---- parseJsonBody ----
test('parseJsonBody: 合法 JSON 对象返回原对象', () => {
  const p = parseJsonBody(Buffer.from('{"a":1}'));
  assert.deepStrictEqual(p, { a: 1 });
});

test('parseJsonBody: 非 JSON 抛 INVALID_JSON', () => {
  assert.throws(() => parseJsonBody(Buffer.from('not json')), e => e.code === 'INVALID_JSON');
});

test('parseJsonBody: 非法 UTF-8 不会替换后转发为合法对话', () => {
  const invalidBodies = [
    Buffer.concat([Buffer.from('{"messages":[{"content":"'), Buffer.from([0xff]), Buffer.from('"}]}')]),
    Buffer.concat([Buffer.from('{"content":"'), Buffer.from([0xe4, 0xbd])]),
  ];
  for (const body of invalidBodies) {
    assert.throws(() => parseJsonBody(body), e => e.code === 'INVALID_UTF8' && /UTF-8/.test(e.message));
  }
  const valid = { content: '中文与 emoji 😀、客户端实际写入的替换字符 �' };
  assert.deepStrictEqual(parseJsonBody(Buffer.from(JSON.stringify(valid))), valid);
});

test('parseJsonBody: 解析错误不回显请求正文，仅保留类别与位置', () => {
  const marker = 'PRIVATE-PROMPT-CONTENT';
  for (const source of [marker, `"${marker}" trailing`, `{"content":"${marker}`]) {
    assert.throws(() => parseJsonBody(Buffer.from(source)), e => {
      assert.strictEqual(e.code, 'INVALID_JSON');
      assert.ok(!e.message.includes(marker));
      assert.match(e.message, /^请求体不是合法 JSON: (语法无效|字符串未闭合|内容未完成)(（位置 \d+）)?$/);
      return true;
    });
  }
});

test('parseJsonBody: 数组/null/标量抛 INVALID_PAYLOAD', () => {
  for (const raw of ['[1,2]', 'null', '42', '"str"']) {
    assert.throws(() => parseJsonBody(Buffer.from(raw)), e => e.code === 'INVALID_PAYLOAD');
  }
});

// ---- normalizePayload: 模型名(1.10.1 起按客户端选择路由) ----
// 契约:调用方**决定**要发的模型(它读过客户端的选择),作为第 2 参传入;
// 本函数把它落到 payload 上。差别在于"决定者"从 config.model(固定)变成了
// 客户端请求里的 model(见 core/proxy-service.js 的 requestedModel)
test('归一化: 调用方给的模型被如实应用(不再固定换成 config.model)', () => {
  // 调用方传 V4.1 → 就发 V4.1(1.10.1 及以前这里会被换成 config.model)
  const p = { model: 'DeepSeek-V4.1-Flash', messages: [] };
  const applied = normalizePayload(p, 'DeepSeek-V4.1-Flash');
  assert.strictEqual(p.model, 'DeepSeek-V4.1-Flash');
  assert.ok(!applied.some(n => n.startsWith('model=')), '同名不该产生改写记录');

  // 调用方已把客户端的选择解析出来并传入 → 落上去
  const q = { model: 'qwen3.8-27b', messages: [] };
  normalizePayload(q, 'qwen3.8-27b');
  assert.strictEqual(q.model, 'qwen3.8-27b');
});

test('归一化: 调用方显式提供模型时写入空 payload（不代表生产默认路由）', () => {
  const p = { messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.ok(!applied.some(n => n.startsWith('model=')), '缺省注入不算"改写"');
});

test('归一化: 已是注入模型时不产生任何 model 记录', () => {
  const p = { model: MODEL, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(applied.length, 0);
});

test('归一化: 调用方传空/非字符串时不覆盖 payload 里的模型', () => {
  // 防御:调用方解析失败时不应把 payload 的 model 抹成空(上游会拒)
  for (const bad of [undefined, null, '', 0]) {
    const p = { model: 'DeepSeek-V4.1-Flash', messages: [] };
    normalizePayload(p, bad);
    assert.strictEqual(p.model, 'DeepSeek-V4.1-Flash', String(bad));
  }
});

// ---- normalizePayload: 上游拒绝参数 ----
test('归一化: logprobs/top_logprobs 剥离并记录', () => {
  const p = { model: MODEL, logprobs: true, top_logprobs: 5, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.ok(!('logprobs' in p) && !('top_logprobs' in p));
  assert.ok(applied.includes('-logprobs') && applied.includes('-top_logprobs'));
});

test('归一化: n>1 剥离, n=1 保留', () => {
  const a = { model: MODEL, n: 3, messages: [] };
  normalizePayload(a, MODEL);
  assert.ok(!('n' in a));
  const b = { model: MODEL, n: 1, messages: [] };
  normalizePayload(b, MODEL);
  assert.strictEqual(b.n, 1);
});

// ---- normalizePayload: max_tokens 区间 [512, 65536] ----
test('max_tokens: 思考开启(默认)时 <512 抬到 512', () => {
  const p = { model: MODEL, max_tokens: 16, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 512);
  assert.ok(applied.includes('max_tokens→512'));
});

test('max_tokens: 显式关闭思考的三种方言均不抬升', () => {
  for (const noThinking of [
    { reasoning_effort: 'none' },
    { thinking: false },
    { thinking: { type: 'disabled' } },
  ]) {
    const p = { model: MODEL, max_tokens: 16, messages: [], ...noThinking };
    const applied = normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, 16, JSON.stringify(noThinking));
    assert.ok(!applied.includes('max_tokens→512'), JSON.stringify(noThinking));
  }
});

// 1.10.1:输出上限改为**逐模型**由调用方传入(见 config.limitsFor)。三个模型窗口
// 差 4 倍,旧的固定 65536 会把 1M 的模型白砍到 1/16 —— 用户实测确定边界后修正
test('max_tokens: 超过该模型预算才压回,并记录实际值(思考开/关两态)', () => {
  for (const extra of [{}, { reasoning_effort: 'none' }]) {
    const p = { model: MODEL, max_tokens: 384000, messages: [], ...extra };
    const applied = normalizePayload(p, MODEL, null, 262144);
    assert.strictEqual(p.max_tokens, 262144);
    assert.ok(applied.includes('max_tokens→262144'), JSON.stringify(applied));
  }
});

test('max_tokens: 1M 窗口的模型不被误压(旧 bug 回归钉)', () => {
  // 客户端按官方目录发 384K 输出规格,1M 窗口的模型应原样放行
  const p = { model: 'DeepSeek-V4.1-Flash', max_tokens: 384000, messages: [] };
  const applied = normalizePayload(p, 'DeepSeek-V4.1-Flash', null, 1048576);
  assert.strictEqual(p.max_tokens, 384000, '1M 模型不得被压到 65536');
  assert.ok(!applied.some(n => n.startsWith('max_tokens→')), '不该有压缩记录');
});

test('max_tokens: 不传预算时不设上限(交上游联合校验仲裁)', () => {
  // 刻意不留"兜底数字":任何硬编码值对 1M 偏小、对 256K 偏大
  const p = { model: MODEL, max_tokens: 900000, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 900000);
  assert.ok(!applied.some(n => n.startsWith('max_tokens→')));
});

test('max_tokens: 缺省时不注入任何值', () => {
  const p = { model: MODEL, messages: [] };
  normalizePayload(p, MODEL);
  assert.ok(!('max_tokens' in p));
});

// ---- normalizePayload: max_completion_tokens(新版 OpenAI 客户端方言) ----
test('max_completion_tokens: 映射为 max_tokens 并接受区间约束(两方向)', () => {
  const big = { model: MODEL, max_completion_tokens: 384000, messages: [] };
  const appliedBig = normalizePayload(big, MODEL, null, 262144);
  assert.strictEqual(big.max_tokens, 262144);
  assert.ok(!('max_completion_tokens' in big));
  assert.ok(appliedBig.includes('max_completion_tokens→max_tokens') && appliedBig.includes('max_tokens→262144'));

  const small = { model: MODEL, max_completion_tokens: 16, messages: [] };
  normalizePayload(small, MODEL);
  assert.strictEqual(small.max_tokens, 512);
});

test('max_completion_tokens: 思考关闭时不抬升,原值映射', () => {
  const p = { model: MODEL, max_completion_tokens: 16, reasoning_effort: 'none', messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_completion_tokens: 两键并存时以新键为准', () => {
  const p = { model: MODEL, max_completion_tokens: 2000, max_tokens: 9000, messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 2000);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_tokens: 512-65536 区间内原样保留', () => {
  for (const mt of [512, 4096, 65536]) {
    const p = { model: MODEL, max_tokens: mt, messages: [] };
    normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, mt);
  }
});

// ---- normalizePayload: 思考参数翻译(1.10.1 重写) ----
// 旧行为是"无条件删除 thinking / reasoning_effort",导致客户端要的思考被整个
// 摘掉(网页端看得到思考、经代理看不到)。1.10.1 起按模型能力翻译:开关落到
// 该模型的 chat_template_kwargs.<thinkingParam>,档位落到顶层 reasoning_effort。
// 无 meta 时走保守路径(只摘输入方言、不注入),故这些用例显式传 meta。

// 测试用 meta:与 config.thinkingFallback 同形(能力表见 core/thinking.js)
const META_DS = { supportImage: true, thinkingParam: 'thinking', thinkingField: 'reasoning_content', effortOptions: ['low', 'medium', 'xhigh'] };
const META_QWEN = { supportImage: true, thinkingParam: 'enable_thinking', thinkingField: 'reasoning', effortOptions: ['low', 'medium', 'xhigh'] };
const META_NOFF = { supportImage: false, thinkingParam: null, thinkingField: 'content', effortOptions: ['low', 'medium', 'high'] };

test('思考方言: reasoning_effort=none → 该模型字段=false 且原键剥离', () => {
  const p = { model: MODEL, reasoning_effort: 'none', messages: [] };
  const applied = normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
  assert.ok(!('reasoning_effort' in p));
  assert.ok(applied.includes('thinking=false') && applied.includes('-reasoning_effort'));
});

test('思考方言: 未表态时按开启注入(接入的 agent 普遍期望思考可用)', () => {
  const p = { model: MODEL, messages: [] };
  const applied = normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: true });
  assert.ok(applied.includes('thinking=true'));
  // 未给档位 → 用该模型首档(与上游网页端取法一致)
  assert.strictEqual(p.reasoning_effort, 'low');
});

test('思考方言: 给的档位精确命中该模型的 effortOptions', () => {
  const p = { model: MODEL, reasoning_effort: 'medium', messages: [] };
  normalizePayload(p, MODEL, META_DS);
  assert.strictEqual(p.reasoning_effort, 'medium');
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: true });
});

test('思考方言: 越档值落到最近合法档(不发非法值给上游)', () => {
  // qwen 无 max,只有 low/medium/xhigh → max 应落到 xhigh
  const p = { model: MODEL, reasoning_effort: 'max', messages: [] };
  normalizePayload(p, MODEL, META_QWEN);
  assert.strictEqual(p.reasoning_effort, 'xhigh');
});

test('思考方言: 客户端惯用的 enabled/怪值绝不透传成非法档位', () => {
  for (const v of ['enabled', 'banana']) {
    const p = { model: MODEL, reasoning_effort: v, messages: [] };
    normalizePayload(p, MODEL, META_DS);
    assert.ok(p.reasoning_effort === undefined || META_DS.effortOptions.includes(p.reasoning_effort),
      `非法的 reasoning_effort 不得透传: ${v} → ${p.reasoning_effort}`);
  }
});

test('思考方言: qwen 用 enable_thinking 而非硬编码 thinking(字段名逐模型不同)', () => {
  const p = { model: MODEL, messages: [] };
  normalizePayload(p, MODEL, META_QWEN);
  assert.deepStrictEqual(p.chat_template_kwargs, { enable_thinking: true });
});

test('思考方言: 不可开关思考的模型(thinkingParam=null)不注入任何开关', () => {
  const p = { model: MODEL, reasoning_effort: 'high', messages: [] };
  const applied = normalizePayload(p, MODEL, META_NOFF);
  assert.ok(!('chat_template_kwargs' in p), '不得为不可开关模型注入开关');
  assert.strictEqual(p.reasoning_effort, 'high');
  assert.ok(applied.includes('-reasoning_effort'));
});

test('思考方言: 不可开关模型 + 客户端明确要关 → 同样不注入', () => {
  // R1-W8A8 的思考由上游决定,客户端无从开关:注入 thinking:false 是没有
  // 依据的猜测,一律不发(与能力未知的保守路径区分开)
  const p = { model: MODEL, reasoning_effort: 'none', messages: [] };
  normalizePayload(p, MODEL, META_NOFF);
  assert.ok(!('chat_template_kwargs' in p));
  assert.ok(!('reasoning_effort' in p));
});

test('思考方言: 无 meta(探测失败/未注入)走保守路径——摘方言但不注入', () => {
  const p = { model: MODEL, reasoning_effort: 'high', messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.ok(!('reasoning_effort' in p));
  assert.ok(!('chat_template_kwargs' in p), '不知道上游字段名时不得乱注入');
  assert.ok(applied.includes('-reasoning_effort'));
});

test('思考方言: 关闭时不发档位', () => {
  const p = { model: MODEL, reasoning_effort: 'none', messages: [] };
  normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
  assert.ok(!('reasoning_effort' in p));
});

test('思考方言: 已有 chat_template_kwargs 被合并保留', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: { custom: 1 }, messages: [] };
  normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { custom: 1, thinking: false });
});

test('思考方言: chat_template_kwargs 为数组时整体替换', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: [1, 2], messages: [] };
  normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
});

test('思考方言: 原生 enable_thinking=false 也被识别为关闭', () => {
  const p = { model: MODEL, enable_thinking: false, messages: [] };
  normalizePayload(p, MODEL, META_DS);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
  assert.ok(!('enable_thinking' in p));
});

// ---- fitTokenBudget:文本预算预检与输出收缩 ----
test('预算适配: 未超限不改不注记', () => {
  const p = { max_tokens: 4096 };
  const r = fitTokenBudget(100000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.note, '');
  assert.strictEqual(p.max_tokens, 4096);
});

test('预算适配: 超限收缩到剩余空间', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(230000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 32144 - CONTEXT_RESERVE_TOKENS);
  assert.ok(r.note.includes(String(p.max_tokens)));
});

test('预算适配: 恰等于估算上限仍保留模板余量', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(196608, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 65536 - CONTEXT_RESERVE_TOKENS);
  assert.ok(r.note.includes(String(p.max_tokens)));
});

test('预算适配: 剩余空间 <512 判 413(prompt 本身超限)', () => {
  const p = { max_tokens: 65536 };
  const r = fitTokenBudget(262000, p, 262144);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, '对话内容过长，请缩短对话或新建会话后重试。');
});

test('预算适配: max_tokens 缺省且 prompt 未超限 → 不注入不收缩', () => {
  const p = {};
  const r = fitTokenBudget(200000, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.note, '');
  assert.strictEqual(p.max_tokens, undefined);
});

test('预算适配: max_tokens 缺省但 prompt 本身超限 → 413', () => {
  const p = {};
  const r = fitTokenBudget(263000, p, 262144);
  assert.strictEqual(r.ok, false);
});

// ---- C5: 思考感知预算(两处,边界 0/1/511/512) ----
test('思考感知: 原生 kwargs thinking:false 时 max_tokens:16 不被抬到 512', () => {
  const p = { model: MODEL, max_tokens: 16, chat_template_kwargs: { thinking: false }, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.ok(!applied.includes('max_tokens→512'));
});

test('思考感知: 方言冲突时任一关闭信号即关闭(effort=high + 原生 false)', () => {
  const p = { model: MODEL, max_tokens: 16, reasoning_effort: 'high', chat_template_kwargs: { thinking: false }, messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.strictEqual(p.chat_template_kwargs.thinking, false);
});

test('思考感知: 关闭思考 + 剩余 100 + 预算 1000 → 收缩到 100 放行', () => {
  const p = { max_tokens: 1000, chat_template_kwargs: { thinking: false } };
  const r = fitTokenBudget(262044 - CONTEXT_RESERVE_TOKENS, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 100);
});

test('思考感知边界: 剩余 0/1/511/512 × 思考开/关', () => {
  // room=262144-prompt-CONTEXT_RESERVE_TOKENS
  const mk = (room, off) => ({
    max_tokens: 1000,
    ...(off ? { chat_template_kwargs: { thinking: false } } : {}),
  });
  // 剩余 0:两种形态都拒绝
  assert.strictEqual(fitTokenBudget(262144 - CONTEXT_RESERVE_TOKENS, mk(0, true), 262144).ok, false);
  assert.strictEqual(fitTokenBudget(262144 - CONTEXT_RESERVE_TOKENS, mk(0, false), 262144).ok, false);
  // 剩余 1:思考关闭收缩到 1;思考开启拒绝(<512)
  const pOff1 = mk(1, true);
  const rOff1 = fitTokenBudget(262143 - CONTEXT_RESERVE_TOKENS, pOff1, 262144);
  assert.strictEqual(rOff1.ok, true);
  assert.strictEqual(pOff1.max_tokens, 1);
  assert.strictEqual(fitTokenBudget(262143 - CONTEXT_RESERVE_TOKENS, mk(1, false), 262144).ok, false);
  // 剩余 511:思考关闭收缩到 511;思考开启拒绝
  const pOff511 = mk(511, true);
  const rOff511 = fitTokenBudget(261633 - CONTEXT_RESERVE_TOKENS, pOff511, 262144);
  assert.strictEqual(rOff511.ok, true);
  assert.strictEqual(pOff511.max_tokens, 511);
  assert.strictEqual(fitTokenBudget(261633 - CONTEXT_RESERVE_TOKENS, mk(511, false), 262144).ok, false);
  // 剩余 512:两种形态都收缩到 512
  const pOn512 = mk(512, false);
  const rOn512 = fitTokenBudget(261632 - CONTEXT_RESERVE_TOKENS, pOn512, 262144);
  assert.strictEqual(rOn512.ok, true);
  assert.strictEqual(pOn512.max_tokens, 512);
  const pOff512 = mk(512, true);
  assert.strictEqual(fitTokenBudget(261632 - CONTEXT_RESERVE_TOKENS, pOff512, 262144).ok, true);
  assert.strictEqual(pOff512.max_tokens, 512);
});

// ---- tools 的上游模板开销(2026-09-29 实测补充) ----
// 上游按自己的 chat 模板序列化工具定义,比本地纯文本计量多算约 16~18 token/个。
// 不补这笔账,带几十个工具的 agent 请求会被上游以 {"errorMessage":"服务器繁忙"}
// 秒拒(实测 qwen + 33 tools + max_tokens=384000 稳定 429)。这是 Windows 下
// ZCode 带 33 个工具时反复失败的机制。
const { TOOL_DEF_TOKENS } = require('../core/payload');

function toolsN(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ type: 'function', function: { name: 'T' + i, description: 'x',
    parameters: { type: 'object', properties: {}, required: [] } } });
  return out;
}

test('预算适配: 带 tools 时按每工具 20 token 计入 prompt(实测斜率上界 18.3)', () => {
  // 实测:本地 prompt 1000、带 10 个工具时,上游实际按 1000+167 计
  // 留 20/个 ⇒ 本函数按 1000+200 计,比实测再多留一点余量(安全侧)
  const p = { max_tokens: 262000, tools: toolsN(10) };
  const r = fitTokenBudget(1000, p, 262144);
  assert.strictEqual(r.ok, true);
  // 工具开销与通用余量分别扣除
  assert.strictEqual(p.max_tokens, 260944 - CONTEXT_RESERVE_TOKENS, '必须把工具开销算进去,否则上游会拒');
});

test('预算适配: 无 tools 时仍保留通用模板余量', () => {
  const p = { max_tokens: 262000 };
  const r = fitTokenBudget(1000, p, 262144);
  // 不带工具开销，但仍保留通用余量
  assert.strictEqual(p.max_tokens, 261144 - CONTEXT_RESERVE_TOKENS);
 });

test('预算适配: tools 为空数组时不加开销', () => {
  const p = { max_tokens: 262000, tools: [] };
  fitTokenBudget(1000, p, 262144);
  assert.strictEqual(p.max_tokens, 261144 - CONTEXT_RESERVE_TOKENS);
});

test('预算适配: tools 非数组(畸形输入)不加开销、不抛错', () => {
  for (const bad of [null, 'x', 42, {}]) {
    const p = { max_tokens: 262000, tools: bad };
    const r = fitTokenBudget(1000, p, 262144);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(p.max_tokens, 261144 - CONTEXT_RESERVE_TOKENS);
  }
});

test('预算适配: 工具开销能把"看似放得下"的请求拖到超限', () => {
  // 本地算 5 + 262000 = 262005 <= 262144,看似放得下;
  // 但带 33 个工具时上游实按 5+604+262000 计 ⇒ 必然被拒。
  // 本函数必须在这时就收缩,而不是等上游 429
  const p = { max_tokens: 262000, tools: toolsN(33) };
  const r = fitTokenBudget(5, p, 262144);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.max_tokens, 262144 - 5 - 33 * TOOL_DEF_TOKENS - CONTEXT_RESERVE_TOKENS);
  assert.ok(p.max_tokens < 262000, '必须收缩');
});

test('预算适配: 工具多到放不下最小预算时仍判 413', () => {
  // prompt 本身 + 工具开销已接近窗口 ⇒ room < 512 ⇒ 拒绝(不是发出去被上游拒)
  const p = { max_tokens: 100, tools: toolsN(33) };
  const r = fitTokenBudget(262000, p, 262144);
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('缩短对话'));
});

test('预算适配: TOOL_DEF_TOKENS 覆盖实测斜率上界', () => {
  // 实测每工具开销:3→16.0 / 10→16.7 / 33→18.3。取 20 留余量;
  // 若有人把它调到 18.3 以下,真实请求会重新撞上游边界
  assert.ok(TOOL_DEF_TOKENS >= 19, '必须 >= 实测斜率上界 18.3,当前 ' + TOOL_DEF_TOKENS);
});

test('预算适配: DSH 的 57 工具历史请求不再超过真实上游窗口', () => {
  // 2026-09-30 重建请求：旧计数 46684，补计历史思考 337；
  // 上游 usage.prompt_tokens 实测 47860，窗口 1048576。
  const p = { max_tokens: 1048576, tools: toolsN(57) };
  assert.strictEqual(fitTokenBudget(47021, p, 1048576).ok, true);
  assert.ok(47860 + p.max_tokens < 1048576, '真实输入与输出预算必须留在窗口内');
  assert.ok(p.max_tokens > 990000, '应只收缩必要余量，不把模型输出能力降成固定小值');
});

// ---- 逐模型输出上限的安全值(2026-09-29 实测边界) ----
// 背景:config 里 qwen 原写 262144(= 它报的窗口),但**这个值本身会被上游拒**
// (`{"errorMessage":"服务器繁忙"}` + 429,0.1s 秒回)。而 payload.js 的归一化
// 只向下压、压到这张表的值 ⇒ 客户端发 384000 之类的大值会被压成 262144,
// 恰好撞墙,请求必然失败(错误文案还误导成"上游忙")。
// 实测边界(经代理逐值探测,本地 prompt=5 时):262103 ✅ / 262104 ❌
const config = require('../config');

test('Qwen 长文本校准样本的输出预算为实际输入保留空间', () => {
  // 2026-10-10 合成英文长文本：本地 62,017，上游 70,917。
  const limits = config.limitsFor('qwen3.8-27b');
  const payload = { max_tokens: limits.maxOutputTokens };
  const budget = estimatePromptBudget(payload, 62017, limits.promptTokenMarginRatio);
  assert.strictEqual(fitTokenBudget(62017, payload, limits.contextWindow, budget).ok, true);
  assert.ok(70917 + payload.max_tokens < limits.contextWindow);
  assert.ok(payload.max_tokens > 180000, '只收缩估算余量，不设置固定的小输出上限');

  const ds = { max_tokens: 1048576 };
  const dsLimits = config.limitsFor('DeepSeek-V4.1-Flash');
  const dsBudget = estimatePromptBudget(ds, 62017, dsLimits.promptTokenMarginRatio);
  fitTokenBudget(62017, ds, dsLimits.contextWindow, dsBudget);
  assert.strictEqual(ds.max_tokens, 1048576 - 62017 - CONTEXT_RESERVE_TOKENS);
});

test('未知图片只占软预算，不改变文本硬余量或注入缺省输出', () => {
  const text = { max_tokens: 262000, messages: [{ role: 'user', content: 'hi' }] };
  const images = { max_tokens: 262000, messages: [{ role: 'user', content: [
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
    { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
  ] }] };
  const textBudget = estimatePromptBudget(text), imageBudget = estimatePromptBudget(images);
  assert.strictEqual(textBudget.reserveTokens, CONTEXT_RESERVE_TOKENS);
  assert.strictEqual(imageBudget.reserveTokens, textBudget.reserveTokens);
  assert.strictEqual(imageBudget.imageTokensEstimate, 32768);
  assert.strictEqual(imageBudget.unknownImageCount, 2);
  const fitted = fitTokenBudget(21, images, 262144);
  assert.strictEqual(fitted.ok, true);
  fitTokenBudget(21, text, 262144);
  assert.strictEqual(images.max_tokens, text.max_tokens - 32768);
  assert.strictEqual(images.max_tokens, 262144 - 21 - CONTEXT_RESERVE_TOKENS - 32768);
  delete images.max_tokens;
  assert.strictEqual(fitTokenBudget(21, images, 262144).ok, true);
  assert.ok(!Object.hasOwn(images, 'max_tokens'));
});

// Valid synthetic 910×1287 grayscale PNG, matching the dimensions in issue #7.
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA44AAAUHAQAAAAA94wETAAAApklEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAuDFCQwABfEkFbwAAAABJRU5ErkJggg==';
function imageMessages(count) {
  return [{ role: 'user', content: Array.from({ length: count }, () => ({
    type: 'image_url', image_url: { url: screenshot },
  })) }];
}

test('图片公式与软余量独立于工具、模板和文本硬余量', () => {
  const budget = estimatePromptBudget({ model: 'DeepSeek-V4.1-Flash',
    tools: toolsN(33), messages: imageMessages(2) }, 101, 0.15);
  assert.deepStrictEqual(budget, { baseReserveTokens: 1024, toolReserveTokens: 660,
    marginTokens: 16, reserveTokens: 1700, imageCount: 2, imageTokensEstimate: 1430,
    imageMarginTokens: 16, dimensionImageCount: 2, unknownImageCount: 0, imageEstimateSource: 'dimensions' });
});

test('issue #7：430066 文本 token、49 个工具和40张截图不再被图片预留误拒', () => {
  const payload = { model: 'DeepSeek-V4.1-Flash', max_tokens: 1048576,
    tools: toolsN(49), messages: imageMessages(40) };
  const before = JSON.stringify(payload.messages);
  const budget = estimatePromptBudget(payload, 430066);
  assert.strictEqual(budget.reserveTokens, 2004);
  assert.strictEqual(budget.imageTokensEstimate, 28600);
  assert.strictEqual(budget.imageMarginTokens, 320);
  assert.strictEqual(fitTokenBudget(430066, payload, 1048576, budget).ok, true);
  assert.strictEqual(payload.max_tokens, 587586);
  assert.strictEqual(JSON.stringify(payload.messages), before, '图片内容完整保留');
});

test('63 张图现场回归：104394 文本 token 与 33 个工具不再因图片估值被拒绝', () => {
  const payload = { max_tokens: 384000, tools: toolsN(33), messages: imageMessages(63) };
  const budget = estimatePromptBudget(payload, 104394);
  assert.strictEqual(budget.reserveTokens, 1684);
  const fitted = fitTokenBudget(104394, payload, 1048576, budget);
  assert.strictEqual(fitted.ok, true);
  assert.strictEqual(payload.max_tokens, 384000);
});

test('64 张图不注入缺省预算，也不提高显式小预算', () => {
  for (const extra of [{}, { max_tokens: 4096 }, { max_tokens: 16, thinking: false }]) {
    const payload = { messages: imageMessages(64), ...extra };
    const fitted = fitTokenBudget(21, payload, 1048576);
    assert.strictEqual(fitted.ok, true);
    assert.strictEqual(payload.max_tokens, extra.max_tokens);
    assert.strictEqual(Object.hasOwn(payload, 'max_tokens'), Object.hasOwn(extra, 'max_tokens'));
  }
});

test('含图请求仍按文字和工具收缩；文字本身超限仍拒绝', () => {
  const context = 32768;
  const payload = { messages: imageMessages(1), tools: toolsN(33), max_tokens: 4096 };
  const reserve = CONTEXT_RESERVE_TOKENS + 33 * TOOL_DEF_TOKENS;
  const fitted = fitTokenBudget(context - reserve - 1000, payload, context);
  assert.strictEqual(fitted.ok, true);
  assert.strictEqual(payload.max_tokens, 1000);
  for (const off of [false, true]) {
    const rejected = { ...payload, max_tokens: 4096, thinking: !off };
    const room = off ? 0 : 511;
    assert.strictEqual(fitTokenBudget(context - reserve - room, rejected, context).ok, false);
  }
});

test('逐模型上限: qwen 的值必须低于实测撞墙值 262104', () => {
  const lim = config.limitsFor('qwen3.8-27b');
  assert.ok(lim.maxOutputTokens < 262104,
    'qwen maxOutputTokens=' + lim.maxOutputTokens + ' 已达/超过实测拒绝边界 262104,大预算请求会必然失败');
  assert.ok(lim.maxOutputTokens >= 200000, '也不能压得太低,否则长输出被无谓截断');
});

test('逐模型上限: DeepSeek 的 1M 规格不被这个墙误伤', () => {
  // 实测 DeepSeek-V4.1-Flash 到 262145+ 全部接受 —— 那个墙只在 qwen 上。
  // 若有人"统一"两个值,这里会红:把 1M 模型白砍到 1/4
  const lim = config.limitsFor('DeepSeek-V4.1-Flash');
  assert.ok(lim.maxOutputTokens > 262104, 'DS 的窗口真是 1M,不该被 qwen 的墙连累');
});

test('逐模型上限: 未知模型走保守默认,不冒进', () => {
  const lim = config.limitsFor('某不存在的模型');
  assert.ok(lim.maxOutputTokens <= 65536, '未知模型不能给大预算(宁可少给)');
  assert.ok(lim.contextWindow > 0);
});

test('逐模型上限: 表里的值不会让"大 max_tokens"被压到撞墙', () => {
  // 端到端性质:客户端发任意大值,归一化后的结果都必须低于 qwen 的实测边界
  const { normalizePayload } = require('../core/payload');
  const meta = config.thinkingFallback['qwen3.8-27b'];
  const lim = config.limitsFor('qwen3.8-27b');
  for (const sent of [384000, 300000, 262145, 262144, 262104]) {
    const pl = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }],
      max_tokens: sent, reasoning_effort: 'enabled' };
    normalizePayload(pl, 'qwen3.8-27b', meta, lim.maxOutputTokens);
    assert.ok(pl.max_tokens < 262104,
      '客户端发 ' + sent + ' 被压成 ' + pl.max_tokens + ',仍会撞上游边界');
  }
});
// ---- 不支持原生工具调用的模型：普通聊天兼容与历史完整性 ----
function r1ToolHistory(content = null) {
  return {
    model: 'DeepSeek-R1-W8A8',
    messages: [
      { role: 'user', content: 'Read the record.' },
      { role: 'assistant', content, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_record', arguments: '{}' } },
      ] },
      { role: 'tool', content: '{"verification_code":"573826"}', tool_call_id: 'c1' },
      { role: 'user', content: 'What was the verification code?' },
    ],
    tools: [{ type: 'function', function: { name: 'read_record' } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
}

for (const content of [null, '', 'I will read the record.']) {
  test('R1 普通聊天保留工具结果与 assistant 正文: ' + JSON.stringify(content), () => {
    const p = r1ToolHistory(content);
    const expected = structuredClone(p.messages);
    delete expected[1].tool_calls;
    normalizePayload(p, p.model);
    assert.deepStrictEqual(p.messages, expected);
    for (const key of ['tools', 'tool_choice', 'parallel_tool_calls']) {
      assert.ok(!(key in p), key);
    }
  });
}

test('R1 保留多条工具结果的顺序、名称和调用 ID', () => {
  const p = r1ToolHistory();
  p.messages.splice(3, 0, { role: 'tool', tool_call_id: 'c2', name: 'read_file',
    content: 'path=notes.txt\nThe second result must remain intact.' });
  p.messages[1].tool_calls.push({ id: 'c2', type: 'function',
    function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } });
  const expected = structuredClone(p.messages);
  delete expected[1].tool_calls;
  normalizePayload(p, p.model);
  assert.deepStrictEqual(p.messages, expected);
});

test('R1 旧式 function 历史也保留结果正文，只移除调用结构', () => {
  const p = { model: 'DeepSeek-R1-W8A8', functions: [{ name: 'read_record' }],
    function_call: 'auto', messages: [
      { role: 'assistant', content: null, function_call: { name: 'read_record', arguments: '{}' } },
      { role: 'function', name: 'read_record', content: 'record=573826' },
    ] };
  const expected = structuredClone(p.messages);
  delete expected[0].function_call;
  normalizePayload(p, p.model);
  assert.deepStrictEqual(p.messages, expected);
  assert.ok(!('functions' in p) && !('function_call' in p));
});

test('R1 普通聊天规则同样移除 required 和指定函数要求', () => {
  for (const choice of ['required', { type: 'function', function: { name: 'read_record' } }]) {
    const p = r1ToolHistory();
    p.tool_choice = choice;
    normalizePayload(p, p.model);
    assert.ok(!('tool_choice' in p) && !('tools' in p));
    assert.strictEqual(p.messages[2].content, '{"verification_code":"573826"}');
  }
});

test('未命中模型的工具调用与历史保持完整', () => {
  for (const model of ['DeepSeek-V4.1-Flash', 'qwen3.8-27b']) {
    const p = r1ToolHistory();
    p.model = model;
    const expected = structuredClone(p);
    normalizePayload(p, model);
    assert.deepStrictEqual(p.messages, expected.messages);
    assert.deepStrictEqual(p.tools, expected.tools);
    assert.strictEqual(p.tool_choice, expected.tool_choice);
  }
});

test('R1 没有工具字段的普通聊天不产生剥离记录', () => {
  const p = { model: 'DeepSeek-R1-W8A8', messages: [{ role: 'user', content: 'Hello' }] };
  const expected = structuredClone(p);
  assert.deepStrictEqual(normalizePayload(p, p.model), []);
  assert.deepStrictEqual(p, expected);
});

test('模型规则支持精确名称、通配和有效正则，按配置快照应用', () => {
  const { compileToolStripRules } = require('../core/tool-strip-rules');
  for (const [pattern, model, strip] of [
    [' qwen3.8-27b , /R1/i ', 'qwen3.8-27b', true],
    ['deepseek-r1-w8a8', 'DeepSeek-R1-W8A8', true],
    ['DeepSeek-*-W8A8', 'DeepSeek-R1-W8A8', true],
    ['qwen3.8-*', 'qwen3x8-27b', false],
    ['/R[0-9]{1,2}/i,qwen3.8-27b', 'qwen3.8-27b', true],
    ['/[/,]R1/i,other', '/R1', true],
    ['/R1\\/test/i,other', 'R1/test', true],
    ['/r1/', 'DeepSeek-R1-W8A8', false],
    ['/r1/ig', 'DeepSeek-R1-W8A8', true],
    ['', 'DeepSeek-R1-W8A8', false],
  ]) {
    const rules = compileToolStripRules(pattern);
    for (let i = 0; i < 2; i++) {
      const p = { model, tools: [{}] };
      normalizePayload(p, model, null, undefined, rules);
      assert.strictEqual(!('tools' in p), strip, pattern);
    }
  }
  for (const raw of ['/R1,other','/R1/z,other','/(/,other','/[abc/']) {
    assert.throws(() => compileToolStripRules(raw), e => e.code === 'INVALID_TOOL_RULE');
  }
  const p = { model: 'Vendor1-Tool-Capable', tools: [{}] };
  normalizePayload(p, p.model);
  assert.ok(p.tools, '默认规则不能误伤名称含 r1 的其他模型');
});
