// core/errors.js
// 错误分类与映射(纯逻辑):上游错误体 → OpenAI 错误响应;上游客户端结果 →
// HTTP 状态码与日志 note。业务错误匹配优先级:结构化状态码 > 结构化错误
// 字段 > HTML 错误页 > 最后有限的文本匹配(不新增无证据的中文文案匹配)。

'use strict';

function translateUpstreamError(bodyObj, raw, status) {
  if (status === 404) {
    return { http: 502, message: '上游返回 404:端点可能已变更' };
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
