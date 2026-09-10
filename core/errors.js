// core/errors.js
// 错误分类与映射(纯逻辑):上游错误体 → OpenAI 错误响应;上游客户端结果 →
// HTTP 状态码与日志 note。业务错误匹配优先级:结构化状态码 > 结构化错误
// 字段 > HTML 错误页 > 最后有限的文本匹配(不新增无证据的中文文案匹配)。

'use strict';

function translateUpstreamError(bodyObj, raw, status, busyHint) {
  if (status === 404) {
    return { http: 502, message: '上游返回 404:端点可能已变更' };
  }
  // HTTP 层 401/403(token 有效期内被吊销等形态)与结构化 status 10003
  // 同等映射:落在最底部会变成语义错误的 502"无法识别的响应"
  if (status === 401 || status === 403) {
    return { http: 401, message: '认证失败(token 无效或被拒绝)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  const detail = bodyObj && (bodyObj.errorMessage || bodyObj.message || bodyObj.error?.message ||
    bodyObj.detail || (typeof bodyObj.error === 'string' ? bodyObj.error : ''));
  if (bodyObj?.status === 10003) {
    return { http: 401, message: '认证失败(token 无效或已过期)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  if (bodyObj?.status === 10001) {
    return { http: 429, message: `上游拒绝:${detail || '(上游未提供详情)'}(可能是上下文超限≈256K、请求体超限 1MB 或服务繁忙)` };
  }
  if (typeof bodyObj?.errorMessage === 'string' && /繁忙/.test(bodyObj.errorMessage)) {
    // 上游对上下文超限的请求也返回同一句"服务器繁忙"(2026-09-10 实测复现:
    // 代码密集长会话被 413 预检门漏放——真实分词密度高于估算口径——上游秒拒,
    // 429+"稍后再试"诱导客户端无退路地循环重试)。busyHint 由调用方按悲观
    // 口径(ASCII/3,实测分词密度下界)复算提供:连下界估算+max_tokens 都超
    // 上限时改判 413,给客户端"新开会话/压缩 history"的正确处置;短小请求
    // 则保持 429 等待语义。误判代价不对称:把真过载标成 413,用户多压缩一次
    // 上下文;把超限标成 429,用户死等重试永不成功
    if (busyHint && busyHint.estHigh + busyHint.tokenBudget > busyHint.contextWindow) {
      return { http: 413, message: `疑似上下文超限:上游对超限请求也返回"服务器繁忙"(实测形态),本请求按悲观口径估算 ${busyHint.estHigh} + max_tokens ${busyHint.tokenBudget} 已超上限 ${busyHint.contextWindow}。请新开会话或压缩 history 后重试;若小请求也报此错,才是上游真的繁忙` };
    }
    return { http: 429, message: `上游繁忙(SSE 内嵌错误): ${bodyObj.errorMessage}` };
  }
  if (detail) return { http: 502, message: `上游拒绝请求: ${String(detail).slice(0, 300)}` };
  if (raw && /<html/i.test(String(raw))) {
    return { http: status >= 500 ? status : 502,
      message: `上游网关/负载均衡返回 HTML ${status} 错误页(实测形态:TsinghuaLB 502,后端瞬时不可达)。稍后重试通常自愈` };
  }
  return { http: 502, message: `上游返回无法识别的响应(前 200 字符): ${String(raw || '').slice(0, 200)}` };
}

// "流未以合法 [DONE] 结束"的形态(截断 / 坏帧 / 总时限):流式与非流式只在
// note 前缀上不同,判定与措辞不各写一份
function describeFailedStream(result, notePrefix, config) {
  if (result.type === 'protocol-error' && result.reason === 'truncated') {
    return { note: `${notePrefix}-truncated`, message: '上游流被截断(未见终止标记 [DONE])' };
  }
  if (result.type === 'protocol-error') {
    return { note: `${notePrefix}-invalid`, message: result.message || '上游 SSE 协议错误' };
  }
  return {
    note: `${notePrefix}-total-timeout`,
    message: `上游流式总超时(${Math.round(config.streamTotalTimeout / 1000)}s)`,
  };
}

module.exports = { translateUpstreamError, describeFailedStream };
