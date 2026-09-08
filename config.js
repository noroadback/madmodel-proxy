// config.js
// 全部环境变量与默认配置的唯一来源。其他模块不得直接读取 process.env
// (platform/paths.js 例外:状态目录与 key 优先级解析自成一域,见其文件头说明)。
// 数字配置拒绝负数、NaN 与无穷值,非法值一律回退默认。

'use strict';

const paths = require('./platform/paths');

// 解析环境变量中的数字:空/未定义用默认值;非有限数、负数回退默认值;
// 0 仅在默认值本身为 0 时有意义,其余场景 0 视同非法(避免 0 意外关掉某项
// 机制,沿旧 `Number(x)||default` 语义)
function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && fallback !== 0)) return fallback;
  return n;
}

const PORT = numberEnv('PROXY_PORT', 8080);

module.exports = Object.freeze({
  host: '127.0.0.1',
  port: PORT,
  model: 'DeepSeek-V4-Flash-0731',
  models: Object.freeze(['DeepSeek-V4-Flash-0731']),
  // 上游能力元数据,经 /v1/models 暴露给接入的 agent 工具(免得各自猜默认值)。
  // 2026-09-08 实测:上下文 262,144(256K,二分精测 262,135+1 过 / ~262,145 拒);
  // 输出参数实测接受到 65,536(模型自然停止早于此)
  contextWindow: 262144,
  maxModelTokens: 65536,
  // PROXY_UPSTREAM / PROXY_TOKEN_FILE:测试注入用(端到端测试指向本地假上游)
  upstream: process.env.PROXY_UPSTREAM || 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions',
  tokenFile: process.env.PROXY_TOKEN_FILE || paths.TOKEN_FILE,
  // 测试注入的 token 文件为明文 JSON(假 token 不走 DPAPI)
  tokenFileInjected: !!process.env.PROXY_TOKEN_FILE,

  // 请求体限制(nginx 1MB 硬限,代理预留 950KB)
  bodyLimit: 950 * 1024,
  bodyTimeout: 60e3,               // 请求体接收完成时限
  promptTokenLimit: 240000,        // prompt 估算上限,留余量于上游 256K 上下文

  // 并发处理硬上限:进程保护(防失控客户端拖垮内存/连接),非常规业务限流;
  // 64 覆盖多子代理编排的合法负载。刻意不可配置——见 proxy-service 注释
  inflightHardLimit: 64,

  // 上游超时与限额(并发不受业务层限制,见 README"设计取舍")
  upstreamHeaderTimeout: 30e3,     // 发出请求到收到响应头的超时
  streamIdleTimeout: 120e3,        // 流式空闲超时(实测晚高峰 ~36tps,120s 足够)
  streamTotalTimeout: numberEnv('PROXY_STREAM_TOTAL_MS', 1200e3),
  nonstreamTotalTimeout: 600e3,    // 非流式聚合总超时(实测流式 600s 不断)
  upstreamJsonBodyLimit: 5 * 1024 * 1024,   // JSON 错误页/直答体上限
  upstreamSseTotalLimit: 64 * 1024 * 1024,  // 单次流总字节上限
  sseLineLimit: 1024 * 1024,       // 尾部未完成行的字节上限(防病态流内存膨胀)

  // 请求编码与诊断
  dumpFailed: process.env.DUMP_FAILED === '1',  // 失败请求体落盘(默认关,隐私)

  // watch 续期调度
  refreshAheadMs: numberEnv('PROXY_REFRESH_AHEAD_MS', 30 * 60 * 1000),
  noTokenWaitMs: numberEnv('PROXY_NO_TOKEN_WAIT_MS', 60e3),
  maxSleepMs: numberEnv('PROXY_MAX_SLEEP_MS', 60 * 60 * 1000),
  retryBackoffMs: Object.freeze([60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3]),

  // HTTP server 调优
  maxConnections: 32,
});
