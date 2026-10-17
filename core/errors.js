// 上游错误映射与流中断提示。推测性原因使用估算口径，HTTP 状态优先。

'use strict';

function translateUpstreamError(bodyObj, raw, status, busyHint) {
  if (status === 404) {
    return { http: 502, message: '上游返回 404:端点可能已变更' };
  }
  if (status === 401 || status === 403) {
    return { http: 401, message: '认证失败，请确认 watch 守护在运行（npm start）。' };
  }
  if (status >= 300 && status < 400) {
    return { http: 502, message: `上游重定向（HTTP ${status}），请检查上游地址与登录状态。` };
  }
  if (status === 413) {
    return { http: 413, message: '请求超过上游大小限制，请缩小图片、减少图片数量或缩短对话。' };
  }
  if (status === 429) {
    return { http: 429, message: '上游限流（HTTP 429），请降低并发并稍后重试。' };
  }
  const detail = bodyObj && (bodyObj.errorMessage || bodyObj.message || bodyObj.error?.message ||
    bodyObj.detail || (typeof bodyObj.error === 'string' ? bodyObj.error : ''));
  if (bodyObj?.status === 10003) {
    return { http: 401, message: 'token 无效或已过期，请确认 watch 守护在运行（npm start）。' };
  }
  // 上游也会在 HTTP 200 中包裹 code:400；不能因此丢失参数错误语义。
  // 仅在成功 HTTP 状态下采用内嵌 400，避免覆盖真实网关或服务端故障。
  const bodyCode = bodyObj?.error?.code ?? bodyObj?.code;
  const badRequest = status === 400 ||
    (status === 200 && (bodyCode === 400 || bodyCode === '400'));
  // 保留标准错误码，便于客户端压缩会话；不能把所有 max_tokens 参数错误都归为超限。
  const contextExceeded = bodyObj?.error?.code === 'context_length_exceeded' ||
    bodyObj?.code === 'context_length_exceeded' ||
    (badRequest && typeof detail === 'string' &&
      /^(?:This model's maximum context length is \d+ tokens\.|Requested token count exceeds the model's maximum context length of \d+ tokens\.)/i.test(detail));
  if (contextExceeded || badRequest) {
    const message = typeof detail === 'string' && detail
      ? detail
      : (typeof raw === 'string' && !/<html/i.test(raw) ? raw : '');
    return {
      http: 400,
      type: 'invalid_request_error',
      ...(contextExceeded ? { code: 'context_length_exceeded' } : {}),
      message: message ? `上游拒绝请求: ${message.slice(0, 1024)}` :
        (contextExceeded ? '上下文超限，请缩短对话或调低输出上限后重试。' :
          '上游拒绝请求（HTTP 400），请检查请求参数。'),
    };
  }
  const likelyOverflow = hint => hint &&
    (hint.promptTokens + hint.tokenBudget > hint.contextWindow ||
      hint.promptTokens >= hint.contextWindow);
  if (typeof detail === 'string' && /同时进行中的请求过多|并发(?:请求)?(?:数)?(?:已满|过多|超[出过])/.test(detail)) {
    return { http: 429, message: '上游并发已满，请稍后重试。' };
  }
  const overflowMessage = '疑似上下文超限，请缩短对话或调低输出上限后重试。';
  const nearLimit = busyHint && busyHint.tokenBudget > 0 && busyHint.reserveTokens > 0 &&
    busyHint.promptTokens + busyHint.tokenBudget + busyHint.reserveTokens >= busyHint.contextWindow;
  const budgetAdvice = '请缩短对话或调低输出上限后重试。';

  if (bodyObj?.status === 10001) {
    if (likelyOverflow(busyHint)) {
      return { http: 413, message: overflowMessage };
    }
    return {
      http: 429,
      message: `上游拒绝请求（10001，${detail ? String(detail).slice(0, 120) : '未提供详情'}）。` +
        (nearLimit ? budgetAdvice : '请检查模型名和请求参数，或缩短对话后重试。'),
    };
  }
  if (typeof bodyObj?.errorMessage === 'string' && /繁忙/.test(bodyObj.errorMessage)) {
    if (likelyOverflow(busyHint)) {
      return { http: 413, message: overflowMessage };
    }
    return { http: 429, message: `上游提示“${bodyObj.errorMessage.slice(0, 120)}”。` +
      (nearLimit ? budgetAdvice : '也可能是参数不兼容，请用短对话和默认参数重试。') };
  }
  if (detail) return { http: 502, message: `上游拒绝请求: ${String(detail).slice(0, 120)}` };
  if (raw && /<html/i.test(String(raw))) {
    return { http: status >= 500 ? status : 502,
      message: `上游返回 HTML 错误页（HTTP ${status}），请稍后重试；持续失败请检查网络与登录状态。` };
  }
  return { http: 502, message: `无法识别上游响应: ${String(raw || '').slice(0, 200)}` };
}

function describeFailedStream(result, notePrefix, config, sentBytes) {
  if (result.type === 'protocol-error' && result.reason === 'truncated') {
    const note = `${notePrefix}-truncated`;
    const idleMs = Number.isFinite(result.idleMs) ? result.idleMs : null;
    if (idleMs === null) {
      return { note, message: '上游回复被截断（缺少 [DONE]），请重试。' };
    }
    const idleS = Math.round(idleMs / 1000);
    const sawBytes = typeof result.sawBytes === 'boolean'
      ? result.sawBytes
      : !(Number.isFinite(result.elapsedMs) && idleMs >= result.elapsedMs);
    if (sawBytes) {
      const delivered = typeof sentBytes === 'number' && sentBytes > 0
        ? `已发送 ${(sentBytes / 1024).toFixed(1)} KB，请重试。`
        : '请重试。';
      return { note, message: `上游流被截断（距上一帧 ${idleS}s 后连接中断）。${delivered}` };
    }
    return { note, message: `上游未产出首字节（已等待 ${idleS}s），连接中断，请重试或缩短对话。` };
  }
  if (result.type === 'protocol-error') {
    return { note: `${notePrefix}-invalid`, message: result.message || '上游 SSE 协议错误' };
  }
  return {
    note: `${notePrefix}-total-timeout`,
    message: `生成超时（${Math.round(config.streamTotalTimeout / 1000)}s），请缩短对话后重试。`,
  };
}

module.exports = { translateUpstreamError, describeFailedStream };
