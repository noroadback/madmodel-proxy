// 代理、上游与调度配置在加载时读取并冻结。
// 启动层、终端交互和平台存储各自管理它们的环境参数。

'use strict';

const paths = require('./platform/paths');
const { MADMODEL_VPN_PREFIX, MADMODEL_TUNNEL_MODELS_URL } = require('./madmodel-auth');

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

// 非回环监听必须配置密钥，启动时由 core/listen-config.js 校验。
const BIND_HOST = (process.env.PROXY_BIND_HOST || '127.0.0.1').trim().toLowerCase();
const API_KEYS = Object.freeze(
  [...new Set((process.env.PROXY_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean))]
);

// WebVPN 隧道默认上游:前缀从 madmodel-auth.js 导出(单一来源——上游 URL、
// 保活地址推导、cookie 回传判定共用同一常量,复制串漂移会造成"上游是隧道
// 但保活静默禁用"的错位)
const DEFAULT_UPSTREAM = `${MADMODEL_VPN_PREFIX}/v1/chat/completions`;

// 隧道形态判定 + 保活探测地址推导(上游同前缀的 /v1/models,GET 轻量)。
// 只对 madmodel 的隧道前缀启用——保活语义与探活判定(classifyProbeStatus)
// 建立在隧道"未认证会话 3xx 跳登录页"的固定形态上;PROXY_UPSTREAM 覆盖成
// 校内直连或测试假上游时,既无隧道会话 cookie 可探,直连域门的 307 还会被
// 误判为 invalid 触发无谓续期,故一律导出 null、保活整体禁用
const upstreamUrl = process.env.PROXY_UPSTREAM || DEFAULT_UPSTREAM;
// tunnelMode 判定。MADMODEL_FORCE_TUNNEL_MODE=1 为测试注入口(集成测试的
// mock 上游不是隧道前缀,但等待重试路径需按隧道形态验证),生产不设
const tunnelMode = process.env.MADMODEL_FORCE_TUNNEL_MODE === '1' ||
  upstreamUrl.startsWith(`${MADMODEL_VPN_PREFIX}/`);
const keepaliveMatch = tunnelMode &&
  /^(.+\/)v1\/chat\/completions$/.exec(upstreamUrl);

// 参考模型只用于启动探测和列表标记，请求始终使用客户端指定的模型。
const MODEL = 'DeepSeek-V4.1-Flash';

// 未校验窗口的模型采用保守值；输入与输出共享上下文，预算不代表实际生成长度。
const DEFAULT_LIMITS = Object.freeze({ contextWindow: 131072, maxOutputTokens: 65536 });

// 静态模型信息集中维护；动态探测的能力字段仍由 model-registry 合并。
const MODEL_PROFILES = {
  'DeepSeek-V4.1-Flash': {
    limits: { contextWindow: 1048576, maxOutputTokens: 1048576 },
    thinking: { thinkingParam: 'thinking', thinkingField: 'reasoning_content', effortOptions: ['low', 'high', 'max'] },
  },
  'qwen3.8-27b': {
    // 262000 适用于 SSE；非流式工具补救受 131072 限制，见 docs/TOKEN-BUDGET.md。
    limits: { contextWindow: 262144, maxOutputTokens: 262000, maxNonstreamOutputTokens: 131072, promptTokenMarginRatio: 0.2 },
    thinking: { thinkingParam: 'enable_thinking', thinkingField: 'reasoning', effortOptions: ['low', 'medium', 'xhigh'] },
    // 2026-10-17 上游已返回原生 tool_calls；缓存乱码隔离仍保留。
    isolateCache: true,
  },
  'DeepSeek-R1-W8A8': {
    // 2026-10-17 报错确认共享窗口；输出预算还需扣除输入与模板余量。
    limits: { contextWindow: 163840, maxOutputTokens: 163840 },
    thinking: { thinkingParam: null, thinkingField: 'content', effortOptions: ['low', 'medium', 'high'] },
  },
};
for (const profile of Object.values(MODEL_PROFILES)) {
  Object.freeze(profile.limits);
  Object.freeze(profile.thinking.effortOptions);
  Object.freeze(profile.thinking);
  Object.freeze(profile);
}
Object.freeze(MODEL_PROFILES);
const profileFor = model => Object.hasOwn(MODEL_PROFILES, model) ? MODEL_PROFILES[model] : null;
const THINKING_FALLBACK = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_PROFILES).map(([id, profile]) => [id, profile.thinking])
));

module.exports = Object.freeze({
  host: BIND_HOST,
  port: PORT,
  // API Key 列表(空=不鉴权)。adapters/http-server.js 据此决定是否校验。
  apiKeys: API_KEYS,
  model: MODEL,
  models: Object.freeze([MODEL]),
  // 探测缺失时的思考能力兜底。
  thinkingFallback: THINKING_FALLBACK,
  rejectsTools(model) {
    return profileFor(model)?.rejectsTools === true;
  },
  isolateCacheFor(model) {
    return profileFor(model)?.isolateCache === true;
  },
  limitsFor(model) {
    return profileFor(model)?.limits || DEFAULT_LIMITS;
  },
  // 兼容未提供逐模型配置的调用方；正常请求使用 limitsFor()。
  contextWindow: DEFAULT_LIMITS.contextWindow,
  maxModelTokens: DEFAULT_LIMITS.maxOutputTokens,
  // 默认使用 WebVPN，上游可由启动场景或环境变量覆盖。
  upstream: upstreamUrl,
  // 隧道形态判定(与 keepaliveUrl 同源):upstream-client 仅在隧道形态回传
  // WebVPN 会话 cookie——直连覆盖(PROXY_UPSTREAM)时把 webvpn 域签发的
  // cookie 发给 madmodel.cs 域属凭据卫生问题
  tunnelMode,
  tokenFile: process.env.PROXY_TOKEN_FILE || paths.TOKEN_FILE,
  // 测试注入的 token 文件为明文 JSON(假 token 不走 DPAPI)
  tokenFileInjected: !!process.env.PROXY_TOKEN_FILE,

  // 请求体上限保护本地内存，上游大小限制由其响应确定。
  bodyLimit: numberEnv('PROXY_BODY_LIMIT_MB', 64) * 1024 * 1024,
  bodyTimeout: 60e3,               // 请求体接收完成时限

  // 本地资源保护上限，不代表上游允许的并发量；上游拒绝另按 429 交付。
  inflightHardLimit: 64,

  // 长上下文冷启动实测首字等待超过 160 秒，为预填充留出余量。
  upstreamHeaderTimeout: numberEnv('PROXY_HEADER_MS', 300e3),
  // 客户端背压等待不计入上游空闲时间。
  streamIdleTimeout: numberEnv('PROXY_IDLE_MS', 300e3),
  streamTotalTimeout: numberEnv('PROXY_STREAM_TOTAL_MS', 1200e3),
  nonstreamTotalTimeout: numberEnv('PROXY_NONSTREAM_TOTAL_MS', 600e3), // 非流式聚合总超时(实测流式 600s 不断)
  upstreamJsonBodyLimit: 5 * 1024 * 1024,   // JSON 错误页/直答体上限
  upstreamSseTotalLimit: 64 * 1024 * 1024,  // 单次流总字节上限
  sseLineLimit: 1024 * 1024,       // 尾部未完成行的字节上限(防病态流内存膨胀)

  // 请求编码与诊断
  debugBudget: process.env.PROXY_DEBUG_BUDGET === '1', // 预算明细仅在排障时输出
  dumpFailed: process.env.DUMP_FAILED === '1',  // 失败请求体落盘(默认关,隐私)

  // 工具补救优先解析完整文本，必要时额外重发一次。
  toolCallFix: process.env.PROXY_TOOL_FIX !== '0',
  // 补救的头部与总时限共用此值，允许较慢的冷启动。
  toolCallRetryTimeoutMs: numberEnv('PROXY_TOOL_RETRY_TIMEOUT_MS', 300e3),

  // watch 续期调度
  refreshAheadMs: numberEnv('PROXY_REFRESH_AHEAD_MS', 30 * 60 * 1000),
  noTokenWaitMs: numberEnv('PROXY_NO_TOKEN_WAIT_MS', 60e3),
  maxSleepMs: numberEnv('PROXY_MAX_SLEEP_MS', 60 * 60 * 1000),
  retryBackoffMs: Object.freeze([60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3]),

  // 隧道 cookie 可早于 token 失效；定期探活，失效后重签整组凭据。
  keepAliveIntervalMs: numberEnv('PROXY_KEEPALIVE_MS', 25 * 60 * 1000),
  keepaliveUrl: keepaliveMatch ? MADMODEL_TUNNEL_MODELS_URL : null,

  // A1 等待重试的等待预算:确认的 WebVPN 会话失效(隧道 3xx)时,代理等
  // watch 重签后重试一次,这里是等待上限(是预算不是恢复时间保证)
  waitRetryBudgetMs: numberEnv('PROXY_RETRY_WAIT_MS', 30 * 1000),

  // 连接上限高于业务并发上限，使过载请求仍能收到 429。
  maxConnections: 128,
});
