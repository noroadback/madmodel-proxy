#!/usr/bin/env node
// smoke-real.js — 真实流量冒烟测试:与 npm test(全程离线)互补。
// 离线套件只能验证"我们已知"的上游帧型;空心跳帧这类行为只有真实流量能
// 暴露(2026-09-05 事故:坏帧严格性误杀网关空心跳帧,60 项离线测试全绿仍翻车)。
// 本脚本走真实上游,供协议处理改动上线后浸泡验证:
//   node smoke-real.js   (前置:代理在跑、token 有效;消耗少量学校配额)
'use strict';

const { resolveApiKey } = require('./paths');

const PORT = Number(process.env.PROXY_PORT) || 8080;
const BASE = `http://127.0.0.1:${PORT}`;

async function chat(body, timeoutMs) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey().key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 180000),
  });
  return { status: r.status, text: await r.text() };
}

let failed = 0;
function check(ok, label, detail) {
  console.log((ok ? '✅ ' : '❌ ') + label + (ok || !detail ? '' : `: ${detail}`));
  if (!ok) failed++;
}

async function main() {
  // 0) 代理在线
  const models = await fetch(`${BASE}/v1/models`).then(r => r.json()).catch(() => null);
  if (!models || !Array.isArray(models.data)) {
    console.error(`❌ 代理未运行(${BASE}),先启动 start.cmd`);
    process.exit(1);
  }

  // 1) 小请求(流式):应完整以 [DONE] 结束,无内嵌错误
  let r = await chat({
    model: 'DeepSeek-V4-Flash', stream: true, max_tokens: 300,
    messages: [{ role: 'user', content: '用一句话回答:1+1 等于几?' }],
  });
  check(r.status === 200 && r.text.trimEnd().endsWith('data: [DONE]') && !r.text.includes('errorMessage'),
    '小请求(流式)完整结束',
    `HTTP ${r.status} | 末尾: ${r.text.slice(-80).replace(/\s+/g, ' ')}`);

  // 2) 中请求(~55KB 上下文,生成持续数秒:暴露流中形态——心跳帧/坏帧/截断)
  const filler = '以下是背景资料,读完后总结。' + '清华大学位于北京市,是一所综合性大学。'.repeat(1100);
  r = await chat({
    model: 'DeepSeek-V4-Flash', stream: true, max_tokens: 800,
    messages: [{ role: 'user', content: `${filler}\n用50字总结以上资料。` }],
  });
  check(r.status === 200 && r.text.trimEnd().endsWith('data: [DONE]') && !r.text.includes('errorMessage'),
    '中请求(~55KB,流式)完整结束',
    `HTTP ${r.status} | 末尾: ${r.text.slice(-80).replace(/\s+/g, ' ')}`);

  // 3) usage 注入生效(真实 token 计数,非全零)
  r = await chat({
    model: 'DeepSeek-V4-Flash', stream: false, max_tokens: 300,
    messages: [{ role: 'user', content: '回答:ok' }],
  });
  let usageOk = false;
  let usageDetail = '';
  try {
    const j = JSON.parse(r.text);
    usageOk = j.usage?.total_tokens > 0;
    usageDetail = `usage=${JSON.stringify(j.usage)}`;
  } catch (e) { usageDetail = r.text.slice(0, 100); }
  check(r.status === 200 && usageOk, 'usage 注入生效(真实计数)', usageDetail);

  console.log(failed
    ? `\n结果: ${failed} 项失败——协议处理与真实上游不兼容,查代理日志中 stream-invalid/截断行`
    : '\n结果: 真实流量冒烟通过');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('❌ 冒烟崩溃:', e.message); process.exit(1); });
