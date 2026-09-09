// core/payload.js
// 请求参数归一化(纯函数,只修改传入 payload,不读环境变量、不做 I/O)。
// 行为契约见 README"边界"与 CHANGELOG 1.1.0"参数归一化"。

'use strict';

const UPSTREAM_REJECTED = ['logprobs', 'top_logprobs'];

// JSON 解析与形态校验:非 JSON / 非对象(null/数组/标量)按 400 挡在业务之前。
// 错误带 code(INVALID_JSON / INVALID_PAYLOAD)与面向用户的消息
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
  return payload;
}

// model 由调用方注入(config.model,本模块保持纯函数);上游模型名带部署日期
// 后缀会轮换,改 config.js 一处即全项目生效
function normalizePayload(payload, model) {
  const applied = [];
  if (payload.model !== model) {
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
  // 关闭思考的方言先判定(判定字段随后会被剥离)
  const wantsNoThinking = payload.reasoning_effort === 'none' ||
    payload.thinking === false || payload.thinking?.type === 'disabled';
  // 推理模型在极小 max_tokens 下会把预算全部耗在思考上,content 恒为空——
  // 客户端的连通性探测常发 16/64 这类小预算(ZCode 实测 max_tokens:16),
  // 会被误判为"模型空响应"。仅在思考开启时抬到下限;思考关闭的请求维持
  // 客户端原值(显式要短回答的请求不被放宽)
  if (!wantsNoThinking && typeof payload.max_tokens === 'number' && payload.max_tokens < 512) {
    payload.max_tokens = 512;
    applied.push(`max_tokens→512`);
  }
  // 上游校验 prompt+max_tokens ≤ 262,144:按官方目录自动配置的客户端(如
  // ZCode 匹配 deepseek-v4-flash 的 384K 输出规格)会发超大 max_tokens,被
  // 上游以"服务器繁忙"错误帧秒拒,流式形态即空流。压到 65536(参数实测
  // 接受,模型自然停止远早于此);prompt 侧的联合校验在 proxy-service 早退
  if (typeof payload.max_tokens === 'number' && payload.max_tokens > 65536) {
    payload.max_tokens = 65536;
    applied.push(`max_tokens→65536`);
  }
  for (const key of ['thinking', 'reasoning_effort']) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (wantsNoThinking) {
    const kwargs = payload.chat_template_kwargs;
    payload.chat_template_kwargs = kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs)
      ? { ...kwargs, thinking: false }
      : { thinking: false };
    applied.push('thinking=false');
  }
  return applied;
}

module.exports = { parseJsonBody, normalizePayload };
