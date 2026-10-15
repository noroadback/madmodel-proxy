// 请求参数归一化(纯函数,只修改传入 payload,不读环境变量、不做 I/O)。

'use strict';

const { applyThinking, readThinkingIntent } = require('./thinking');
const { estimateVisionBudget } = require('./vision-budget');

const UPSTREAM_REJECTED = ['logprobs', 'top_logprobs'];

// 内部状态在入口剔除，防止客户端伪造工具降级标记并绕过 tool_choice:none。
const INTERNAL_PREFIX = '__';

// JSON 解析与形态校验:非 JSON / 非对象(null/数组/标量)按 400 挡在业务之前。
// 错误带 code(INVALID_JSON / INVALID_PAYLOAD)与面向用户的消息。
// 同时剔除 `__` 前缀的内部保留键(见 INTERNAL_PREFIX 说明)
function parseJsonBody(rawBody) {
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch (e) {
    const err = new Error(`请求体不是合法 JSON: ${e.message}`);
    err.code = 'INVALID_JSON';
    throw err;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('请求体必须是 JSON 对象(chat completion 格式)');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  // 剔除内部保留键。静默剔除而非 400:客户端并不需要这些键,报错只会让
  // 用户看到一个看不懂的失败;剔除后行为与"没发这个键"完全一致
  for (const k of Object.keys(payload)) {
    if (k.startsWith(INTERNAL_PREFIX)) delete payload[k];
  }
  return payload;
}

// model 与 meta 由调用方提供；缺少模型名时原样保留，由上游校验。
function normalizePayload(payload, model, meta, maxOutputTokens) {
  const applied = [];
  // 把调用方解析出的模型名落到 payload 上(调用方读的是客户端的原始选择)。
  // 空串表示"客户端没写":不动它,让上游如实回"模型不存在"
  if (typeof model === 'string' && model && payload.model !== model) {
    if (payload.model !== undefined) applied.push('model=' + String(payload.model).slice(0, 40));
    payload.model = model;
  }
  for (const key of UPSTREAM_REJECTED) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (payload.n !== undefined && payload.n !== 1) {
    delete payload.n;
    applied.push('-n');
  }
  // 在翻译字段前读取思考意图，供输出预算下限使用。
  const wantsNoThinking = readThinkingIntent(payload) === false;
  // 两种输出预算参数先合并，再统一约束；同时存在时以新键为准。
  if (typeof payload.max_completion_tokens === 'number') {
    payload.max_tokens = payload.max_completion_tokens;
    delete payload.max_completion_tokens;
    applied.push('max_completion_tokens→max_tokens');
  }
  // 思考开启时避免过小预算耗尽在推理中，导致客户端探测得到空正文。
  if (!wantsNoThinking && typeof payload.max_tokens === 'number' && payload.max_tokens < 512) {
    payload.max_tokens = 512;
    applied.push(`max_tokens→512`);
  }
  // 先约束该模型的输出上限，再由 fitTokenBudget 按剩余上下文收缩。
  // 未提供上限时交由上游校验，不在这里另设默认值。
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 &&
      typeof payload.max_tokens === 'number' && payload.max_tokens > maxOutputTokens) {
    payload.max_tokens = maxOutputTokens;
    applied.push(`max_tokens→${maxOutputTokens}`);
  }
  // 最后翻译思考字段，避免影响上面的预算下限判定。
  for (const n of applyThinking(payload, meta)) applied.push(n);
  return applied;
}

// 文本、工具与模板余量用于预检；图片估值另列，只辅助收缩输出，
// 不作为本地拒绝请求的依据。未指定 max_tokens 时不注入默认值。
// 工具定义按上游模板渲染的实测额外开销约为每项 16~18 token，预留 20。
const TOOL_DEF_TOKENS = 20;
// 模板与本地计数仍可能有偏差，不把输出预算压到估算窗口的最后一个 token。
const CONTEXT_RESERVE_TOKENS = 1024;
function estimatePromptBudget(payload, promptTokens = 0, marginRatio = 0) {
  const toolCount = Array.isArray(payload?.tools) ? payload.tools.length : 0;
  const toolReserveTokens = toolCount * TOOL_DEF_TOKENS;
  const marginTokens = Math.ceil(promptTokens * marginRatio);
  return {
    baseReserveTokens: CONTEXT_RESERVE_TOKENS,
    toolReserveTokens,
    marginTokens,
    reserveTokens: CONTEXT_RESERVE_TOKENS + toolReserveTokens + marginTokens,
    ...estimateVisionBudget(payload),
  };
}

function fitTokenBudget(promptTokens, payload, contextWindow,
  estimate = estimatePromptBudget(payload, promptTokens)) {
  const reserve = estimate.reserveTokens;
  const effectivePrompt = promptTokens + reserve;
  const originalBudget = payload.max_tokens;
  const budget = typeof originalBudget === 'number' ? originalBudget : 0;
  const room = contextWindow - effectivePrompt;
  // 思考关闭的判定与归一化同源(core/thinking.js 认三方言+原生)。生产路径
  // 恒先归一化(届时思考意图已被翻译掉),但本函数不静默依赖该前置——
  // 直接调用的原始形态方言同样得到正确下限
  const noThinking = readThinkingIntent(payload) === false;
  const floor = noThinking ? 1 : 512;
  if (effectivePrompt + budget > contextWindow) {
    if (room < floor) {
      return {
        ok: false,
        message: '对话内容过长，请缩短对话或新建会话后重试。',
      };
    }
    payload.max_tokens = room;
  }

  if (estimate.imageCount > 0 && typeof payload.max_tokens === 'number') {
    const estimatedRoom = room - estimate.imageTokensEstimate - estimate.imageMarginTokens;
    // 估值不足以保留最低输出时，交由上游按实际用量判断，避免图片高估
    // 再次误拒合法请求，或把输出预算强行压到 0/最低值。
    if (estimatedRoom >= floor && payload.max_tokens > estimatedRoom) {
      payload.max_tokens = estimatedRoom;
    }
  }

  return {
    ok: true,
    note: payload.max_tokens !== originalBudget
      ? ` norm[max_tokens→${payload.max_tokens} 预检收缩]` : '',
  };
}

module.exports = { parseJsonBody, normalizePayload, fitTokenBudget, estimatePromptBudget,
  TOOL_DEF_TOKENS, CONTEXT_RESERVE_TOKENS };
