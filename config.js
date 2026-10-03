// config.js
// 全部环境变量与默认配置的唯一来源:读取 process.env 并落到冻结的配置对象,
// 业务代码一律经本模块取值,不各自去读环境(取值口径、默认值、非法值回退
// 只在这里定义一次)。
// 例外(各自成域,不属本模块口径):platform/paths.js 的状态目录重定向
// (MADMODEL_STATE_DIR / MADMODEL_CREDS_FILE / USERPROFILE)、
// platform/*/credentials.js 的平台存储细节、dashboard.js 的 PROXY_UPSTREAM
// 写入(启动层要在 spawn 前把场景决定传给子进程,子进程再由本模块读出;
// network-choice.js 只读不写,它算好的场景由 dashboard 落进环境);
// dashboard.js 另读 PROXY_NO_UPDATE_CHECK(只在 dashboard 进程内生效,
// 不随子进程环境传递)。
// 数字配置拒绝负数、NaN 与无穷值,非法值一律回退默认。

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

// 监听地址。默认 127.0.0.1(仅本机,历史行为不变)。设 PROXY_BIND_HOST=0.0.0.0
// 可对局域网开放——此时**必须**配 PROXY_API_KEYS 才是安全的:非回环监听下,
// Host 白名单不再是边界(外部 IP 的 Host 头本就不在白名单),鉴权取而代之。
// 判定见 adapters/http-server.js 的 bindsNonLoopback / requireAuth。
const BIND_HOST = process.env.PROXY_BIND_HOST || '127.0.0.1';

// API Key 鉴权。逗号分隔的 key 列表;非空即开启 Bearer/x-api-key 校验(时间
// 恒定比较)。空(默认)= 不鉴权,沿用"仅本机回环 + Host 白名单"的原边界。
// 对外监听(PROXY_BIND_HOST 非回环)时强烈建议设置,否则任何能到达端口的人
// 都能用。
const API_KEYS = Object.freeze(
  String(process.env.PROXY_API_KEYS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
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

// 用于**启动横幅高亮与验证**的模型名(不参与路由)。
//
// 重要:**代理不再有"默认模型"**。请求原样按客户端写的 model 走,客户端没写
// 就让上游如实回"模型不存在"——代理不替用户挑(1.10.1 定案,用户明确要求)。
// 故本字段**不影响任何请求的走向**,只在启动时用来:① 探测它是否仍然可用并
// 在横幅里点名告警 ② 标出 /v1/models 里的 preferred 项供客户端预选。
//
// 上游随时增删改模型:2026-09-27 原 DeepSeek-V4-Flash-0731 下架;2026-09-28
// DeepSeek-V4-Flash-Vision-Exp 下架(实测 not-found)。所以这只是"我们关注哪个",
// 不是"用户必须用哪个"——它下架了不影响其他模型可用
const MODEL = 'DeepSeek-V4.1-Flash';

// 思考参数的能力元数据**静态兜底**(2026-09-28 从上游前端 bundle 抄录)。
// 正常路径由启动探测从 bundle 动态解析(core/model-discovery.js 的
// parseModelList);这里只防"探测失败/模型不在清单"的情形——没有它,
// payload 会走保守路径,客户端要的思考会静默丢失(而网页端给得到)。
// 键为上游模型名,值同 parseModelList 的 meta 形态。**只录已实测确认的
// 字段名与档位值**;上游改版后本表可能过期,过期只影响兜底不影响正常路径。
//
// 维护:模型下架后应把它的条目删掉(留着无害,但会让这张表看起来比实际可信)。
// 2026-09-28 删除已下架的 DeepSeek-V4-Flash-Vision-Exp
const THINKING_FALLBACK = Object.freeze({
  'DeepSeek-V4.1-Flash': { thinkingParam: 'thinking', thinkingField: 'reasoning_content', effortOptions: ['low', 'high', 'max'] },
  'qwen3.8-27b': { thinkingParam: 'enable_thinking', thinkingField: 'reasoning', effortOptions: ['low', 'medium', 'xhigh'] },
  'DeepSeek-R1-W8A8': { thinkingParam: null, thinkingField: 'content', effortOptions: ['low', 'medium', 'high'] },
});

// 逐模型的上下文与输出预算上限(2026-09-28 用户实测确定,边界法:恰好到界通过、
// 多 1 token 被拒)。上游按 `输入 token + max_tokens ≤ 窗口` 联合校验,故两个数
// 共用一个窗口、不能相加。
//
// **这里的数字是"参数接受边界",不等于"已验证可实际输出这么多"**——实测连续生成
// 只验证到 8192 token(含思考)。能力上限与默认输出预算是两件事,不要混为一谈。
//
// 逐模型是必须的:三者的窗口差 4 倍(1M vs 256K),用一个值会让 1M 的模型被白白
// 限制到 1/4,或让 256K 的模型收到必然被拒的请求。
//
// ⚠️ 2026-09-29 修正 qwen 的值:原写 262144(= 它报的窗口),但**实测这个值本身
// 就会被上游拒**(`{"errorMessage":"服务器繁忙"}` + 429,0.1s 秒回)。边界实测
// (二分法,经本代理逐值探测):
//     qwen   262103 ✅ / 262104 ❌ 「最大可接受 262103」
//     DeepSeek-V4.1-Flash 到 262145+ 全部 ✅(它的窗口真的是 1M,不受这个墙影响)
// ⇒ 这个 262104 的墙**只在 qwen 上**,不是全局边界(我先前误判过一次,记此纠正)。
//
// 危害在于 `payload.js` 的归一化**只向下压、压到这张表的值**:客户端(ZCode 按
// 模型规格自动配时常见)发 384000 之类的大值 ⇒ 被压成 262144 ⇒ **恰好撞墙、
// 请求必然 429**,而错误文案还是那句会误导人的"服务器繁忙"。
//
// 故 qwen 的值取 262000 留出余量(比实测边界低 103 ≈ 0.04%,对任何实际用途无损;
// 留余量是因为上游边界可能随负载/版本浮动——实测 262101~262103 区间已出现
// 非单调,262104 之后全拒,不适合贴着 262103 钉死)。
const MODEL_LIMITS = Object.freeze({
  'DeepSeek-V4.1-Flash': Object.freeze({ contextWindow: 1048576, maxOutputTokens: 1048576 }),
  'qwen3.8-27b': Object.freeze({ contextWindow: 262144, maxOutputTokens: 262000 }),
  // DeepSeek-R1-W8A8 的窗口**未经实测**,故不在此表内 —— 它走 DEFAULT_LIMITS
  // 的保守值。宁可少给,不可凭推测发出必然被拒的请求。等实测后可补
});

// 清单里没有的模型名走这份保守默认(旧值):宁可少给,不可发出必然被拒的请求
const DEFAULT_LIMITS = Object.freeze({ contextWindow: 131072, maxOutputTokens: 65536 });

// 哪些模型**不能**接受 `tools` 字段(带 tools 的请求会被上游拒或干脆不给调用)。
//
// qwen3.8-27b:带 `tools` 且 `tool_choice` 非 `none` 时,上游约 55–160ms 就回
// `{"errorMessage":"服务器繁忙，请稍后再试"}`(上游的万能错误文案,此处实为
// "参数不被接受")。而 `tools` + `tool_choice:'none'` 能正常返回——模型把调用
// 意图写成 Hermes 文本(<tool_call><function=X>…)。
//
// 故对这类模型,代理把 `tool_choice` 改写成 `'none'`(绕开被拒的路径),再由
// 既有补救路径解析文本、合成标准 tool_calls 交付。工具定义**仍然发给模型**
// ——实测对照:不带 tools 时模型答"无法查天气",带 tools + none 时会输出调用。
//
// 历史:2026-09-28 曾把 DeepSeek-V4-Flash-Vision-Exp 也列在这里(它在默认/auto
// 下不给调用、只在 none 下吐 DSML)。该模型随后被上游下架,条目已删。
// 新模型若出现同类症状,按"Symptoms: 带 tools 被拒 或 默认下不给调用"加入本表
const TOOLS_UNSUPPORTED = Object.freeze(['qwen3.8-27b']);

module.exports = Object.freeze({
  host: BIND_HOST,
  port: PORT,
  // API Key 列表(空=不鉴权)。adapters/http-server.js 据此决定是否校验。
  apiKeys: API_KEYS,
  model: MODEL,
  models: Object.freeze([MODEL]),
  // 探测失败时的思考能力兜底(见上方 THINKING_FALLBACK 的说明)
  thinkingFallback: THINKING_FALLBACK,
  // 该模型是否需要在带 tools 时降级 tool_choice(见 TOOLS_UNSUPPORTED 说明)
  rejectsTools(model) {
    return TOOLS_UNSUPPORTED.includes(model);
  },
  // 2026-09-30 实测:Qwen 重用上游缓存时可能输出多语系乱码,全新 cache_salt
  // 可规避,固定 salt 再次使用仍会复发。仅隔离已验证受影响的模型;
  // 代价是放弃跨请求前缀缓存命中,待上游修复并复验后再移除此规则。
  isolateCacheFor(model) {
    return model === 'qwen3.8-27b';
  },
  // 逐模型上限表 + 未知模型的保守默认。请求路径按**客户端实际选的模型**取
  limitsFor(model) {
    return Object.hasOwn(MODEL_LIMITS, model) ? MODEL_LIMITS[model] : DEFAULT_LIMITS;
  },
  // 上游能力元数据,经 /v1/models 暴露给接入的 agent 工具(免得各自猜默认值)。
  // 下面两个是**兼容旧引用**的默认值(探测未完成/未知模型时用),请求路径请走
  // limitsFor()。数值本身见 MODEL_LIMITS 的说明
  contextWindow: DEFAULT_LIMITS.contextWindow,
  maxModelTokens: DEFAULT_LIMITS.maxOutputTokens,
  // PROXY_UPSTREAM / PROXY_TOKEN_FILE:测试注入用(端到端测试指向本地假上游)
  // 2026-09-10 起 madmodel 直连域名被新版 TsinghuaLB(26.09.07)的 oauth 门禁接管
  // (未带 LB 凭证的请求一律 307 到 oauth.tsinghua.edu.cn,跟随回跳链丢失
  // Authorization/请求体,最终 10003;当日校外网络实测复现)。WebVPN 隧道
  // (wengine_vpn_ticket cookie + Bearer)不受该门禁影响,实测稳定可用,故
  // 上游默认走隧道;隧道 cookie 由认证链随 token 一同刷新持久化(存取见
  // platform 侧与 upstream-client 的 Cookie 头)。
  upstream: upstreamUrl,
  // 隧道形态判定(与 keepaliveUrl 同源):upstream-client 仅在隧道形态回传
  // WebVPN 会话 cookie——直连覆盖(PROXY_UPSTREAM)时把 webvpn 域签发的
  // cookie 发给 madmodel.cs 域属凭据卫生问题
  tunnelMode,
  tokenFile: process.env.PROXY_TOKEN_FILE || paths.TOKEN_FILE,
  // 测试注入的 token 文件为明文 JSON(假 token 不走 DPAPI)
  tokenFileInjected: !!process.env.PROXY_TOKEN_FILE,

  // 请求体接收上限 = **内存保护**,不是上游的限制。
  //
  // 上游网关对请求体的真实上限**会变**:2026-09-28 上午逐字节实测恰为
  // 1,048,576 字节(1,048,577 即 413);**同日晚间复测,1.2MB 已放行,墙移到
  // 5MB~16MB 之间**(16MB 仍 413)。把代理钉在任何实测值上都会过时——已经
  // 过时两次(950KB、1MiB),其中 950KB 还白白拦掉了上游本来能收的请求。
  //
  // 故这里的 16MB 只防"失控客户端把代理内存撑爆"(Content-Length 预检在收
  // 任何字节前拒绝,读中超限即弃);真正的墙由网关当前配置决定,超墙时上游
  // 回 413,代理翻译成可操作的中文(core/errors.js)。正常使用远够不到 16MB。
  bodyLimit: 16 * 1024 * 1024,
  bodyTimeout: 60e3,               // 请求体接收完成时限

  // 本地资源保护上限，不代表上游允许的并发量；上游拒绝另按 429 交付。
  inflightHardLimit: 64,

  // 上游超时与响应大小限额。
  // 75s 高于学校网关自身的 60s 超时(2026-09-13/15 两次故障实测:后端死时
  // 精确 60s 返回 504)。设 30s 时我们比学校先放弃——过载期 31~60s 能回的
  // 请求被误杀,后端真死时用户看到我们的含糊 502 而非学校网关的 504。
  // 75s 让学校的 60s 仲裁先跑完:慢而活着的走完,真死的拿到准确 504
  upstreamHeaderTimeout: 75e3,     // 发出请求到收到响应头的超时
  // 守卫是学校网关读空闲墙(60s,2026-09-16 实测:直连与隧道都有,非流式
  // 60.1s 收 504;流式下首帧等待与流中静默同样会撞)之后的影子兜底,哲学同
  // 上方 75s 的 upstreamHeaderTimeout——让学校的 60s 仲裁先跑完:网关掐的流
  // 以"EOF 无 [DONE]"到达,错误文案据此归因网关(core/errors.js);本守卫只兜
  // 网关掐不动的挂死形态(TCP 挂死不收包时连 EOF 都没有)。不得压到墙下:
  // 上游对流式请求先回响应头再静默预填,idle 计时从响应头到达就开始,实测
  // 121k token 首帧 58.4s——守卫若 <60s 会先掐掉这类合法请求,且掐出的
  // idle-timeout 形态让网关归因文案永不触发。65s = 墙 + 5s 余量。背压静默
  // 已不计入(交付期间守卫挂起,见 core/upstream-client.js)
  streamIdleTimeout: numberEnv('PROXY_IDLE_MS', 65e3),
  streamTotalTimeout: numberEnv('PROXY_STREAM_TOTAL_MS', 1200e3),
  nonstreamTotalTimeout: numberEnv('PROXY_NONSTREAM_TOTAL_MS', 600e3), // 非流式聚合总超时(实测流式 600s 不断)
  upstreamJsonBodyLimit: 5 * 1024 * 1024,   // JSON 错误页/直答体上限
  upstreamSseTotalLimit: 64 * 1024 * 1024,  // 单次流总字节上限
  sseLineLimit: 1024 * 1024,       // 尾部未完成行的字节上限(防病态流内存膨胀)

  // 请求编码与诊断
  dumpFailed: process.env.DUMP_FAILED === '1',  // 失败请求体落盘(默认关,隐私)

  // 工具调用补救(2026-09-27 起)。上游只在**非流式**请求下返回工具调用,且是
  // 自有方言的纯文本(<｜DSML｜invoke name="X">…),tool_calls 字段恒为 null;
  // 而本代理为绕学校 60s 网关强制流式,流式下上游连该文本都不返回——客户端
  // 收到空回复,工具调用整体不可用。开启后:带 tools 的请求若流式返回空,
  // 用非流式重发一次拿到该文本,解析成结构化 tool_calls 交付(见 core/dsml.js)。
  // 默认开——不开的话工具调用根本用不了。上游修好后可设 =0 恢复纯透传
  toolCallFix: process.env.PROXY_TOOL_FIX !== '0',
  // 补救重发的超时(毫秒)。实测工具调用耗时分部极不均匀:中位数约 1.2s,但
  // **冷启动首字节实测到过 70.5s**(非流式重发),尾部还有更长的样本。故默认
  // 给足 120s,并同时用作重发的头超时(覆盖 upstream-header 的 75s 默认——
  // 那个值是按"绕学校 60s 网关"的常规请求定的,对补救太紧,会把冷启动的重发
  // 误掐)。超时则如实交付原文(不伪造工具调用)
  toolCallRetryTimeoutMs: numberEnv('PROXY_TOOL_RETRY_TIMEOUT_MS', 120e3),

  // watch 续期调度
  refreshAheadMs: numberEnv('PROXY_REFRESH_AHEAD_MS', 30 * 60 * 1000),
  noTokenWaitMs: numberEnv('PROXY_NO_TOKEN_WAIT_MS', 60e3),
  maxSleepMs: numberEnv('PROXY_MAX_SLEEP_MS', 60 * 60 * 1000),
  retryBackoffMs: Object.freeze([60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3]),

  // WebVPN 隧道会话保活:实测(2026-09-10)cookie 空闲约 2 小时失效(隧道对
  // 未认证会话固定 302 → /login),而 token 有效期约 5 小时——只随 token 续期
  // 的话,闲置超过 cookie 寿命后代理会坏到下个续期窗口。watch 每周期带
  // cookie 探活隧道:请求本身重置隧道空闲计时,失效则立刻重签 token+cookie。
  // 探测失败分类见 madmodel-auth.js probeWebvpnSession;注入与循环在
  // auth-service.watch / core/scheduler.js
  keepAliveIntervalMs: numberEnv('PROXY_KEEPALIVE_MS', 25 * 60 * 1000),
  keepaliveUrl: keepaliveMatch ? MADMODEL_TUNNEL_MODELS_URL : null,

  // A1 等待重试的等待预算:确认的 WebVPN 会话失效(隧道 3xx)时,代理等
  // watch 重签后重试一次,这里是等待上限(是预算不是恢复时间保证)
  waitRetryBudgetMs: numberEnv('PROXY_RETRY_WAIT_MS', 30 * 1000),

  // HTTP server 调优
  // socket 层连接上限,必须**高于** inflightHardLimit(64):低于它时超限连接
  // 会被 Node 直接 destroy,客户端拿到裸 ECONNRESET,而应用层那个"过载保护,
  // 请降低并发"的 429 文案永远发不出去(实测 maxConnections=2 时第 3 个连接
  // 即 ECONNRESET)。128 给 64 个在途留一倍余量,容纳 keep-alive 复用、探活
  // 与不进入上游就被本地拒掉的连接
  maxConnections: 128,
});
