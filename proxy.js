// 本地 OpenAI 端点入口。组装请求服务、凭据热加载与后台模型探测。
'use strict';

const config = require('./config');
const { validateListenConfig, localBaseUrl } = require('./core/listen-config');
try { validateListenConfig(config); }
catch (error) { console.error(error.message); process.exit(1); }
const { createUpstreamClient } = require('./core/upstream-client');
const { createProxyService } = require('./core/proxy-service');
const { createHttpServer, createTokenCache, createTokenState } = require('./adapters/http-server');
const { getTokenizer } = require('./core/tokenizer');
const { discoverModels, parseModelList, formatModelTable, describeProbeFailure, createDiscoveryRunner } = require('./core/model-discovery');
const { createModelRegistry } = require('./core/model-registry');
const paths = require('./platform/paths');
const { atomicWrite } = require('./platform/file-store');
const { createCredentialWaiter } = require('./adapters/http-server');

// 隧道会话失效的快速自愈:代理遇隧道 3xx(会话被拒)时写 revive 标志,watch
// 的目录监听唤醒后立即探活重签——网络切换后 WebVPN 会话绑定失效的场景,
// 自愈从"最长等 25 分钟常规保活"压到秒级。节流:10s 内至多写一次,请求
// 风暴不放大为文件事件风暴;写失败由常规保活兜底
let lastReviveAt = 0;
function notifyTunnelAuthLost() {
  const now = Date.now();
  if (now - lastReviveAt < 10e3) return;
  try {
    atomicWrite(paths.TUNNEL_REVIVE, String(now));
    lastReviveAt = now; // 写成功才占用节流窗口:写失败(磁盘满/权限)不吞掉
                        // 10s 内的下一次尝试,只让常规保活兜底
  } catch (e) { /* 写失败:常规保活兜底 */ }
}

// 上游 Web 前端根(用于取 bundle 里的模型清单)。**直连域,不是隧道前缀**:
// 2026-09-27 实测直连域名已撤销 oauth 门禁(根路径返回 200 SPA 首页),首页
// HTML 里带 index-*.js 的路径,该 bundle 内含权威的 modelList(带 supportImage
// 等能力标注)。bundle 取不到不算失败——退回只探活 config 里的模型
const MADMODEL_WEB = 'https://madmodel.cs.tsinghua.edu.cn';

// token 读取/缓存与状态判定先于 service 与 HTTP 层独立创建,再分别注入:
// 依赖单向流动。此前 service 经闭包前向引用尚未创建的 httpServer(TDZ,
// 当前惰性调用安全,但构造期调用或重构极易踩 ReferenceError)
const getToken = createTokenCache(config);
const tokenState = createTokenState(getToken);
// 已发现模型清单的运行时可变态(初始回退到 config.model)。HTTP 层据此生成
// /v1/models 响应;探测完成后 publish 替换。1.10.1 起它同时是**路由与能力的
// 依据**:请求按客户端选择的模型真实路由,思考参数按该模型的 meta 翻译
// (thinkingParam/effortOptions 逐模型不同,见 core/thinking.js)、窗口与输出
// 上限按 config.limitsFor(该模型)取。故必须**先建再注入** service
// (见 core/model-registry.js 的说明)
const modelRegistry = createModelRegistry(config);
const service = createProxyService({
  config,
  tokenState,
  upstreamClient: createUpstreamClient(config),
  onTunnelAuthLost: notifyTunnelAuthLost,
  // A1 等待重试:凭据等待器轮询 token 缓存(mtime 失效,watch 重签原子
  // 替换后即见新值),凭据指纹为 token+cookie 组合
  waitForCredentials: createCredentialWaiter(getToken),
  modelRegistry,
});

const httpServer = createHttpServer({ config, service, getToken, modelRegistry });

// 预检门用本地分词器估算 token:7.8MB 词表一次性解析(约 300ms)落在
// 启动期,首个请求不再付这笔
getTokenizer();

process.on('unhandledRejection', e => {
  // 长驻进程:记日志不退出,单次请求的异常不应拖垮整个代理。
  // 只打 message:堆栈含本机绝对路径,控制台输出常被贴进 issue
  console.error(`[${new Date().toTimeString().slice(0, 8)}] [unhandledRejection]`,
    e?.message || e);
});
process.on('uncaughtException', e => {
  // 同步异常的最后防线:记一行后退出,由 dashboard 自动重启接管(无 dashboard
  // 时用户运行 npm start)。比带着损坏状态继续服务更安全
  console.error(`[${new Date().toTimeString().slice(0, 8)}] [uncaughtException]`,
    e?.message || e);
  process.exit(1);
});

httpServer.server.listen(config.port, config.host, () => {
  const auth = httpServer.auth;
  console.log(`服务已启动 ${localBaseUrl(config)}/v1`);
  if (config.apiKeys.length) {
    console.log(`已启用 API Key 鉴权，监听 ${config.host}`);
  } else {
    console.log('仅本机可用，API key 填任意非空值');
  }
  const t = auth.getToken();
  if (t) {
    const remainMin = Math.round((t.expiresAt - Date.now()) / 60e3);
    if (remainMin <= 0) {
      // 启动竞态:start.cmd 同时拉起 watch 与代理,代理先读到的是续期前的旧 token
      console.log('token 已过期，等待自动续期；若未启动 watch，请运行 npm start');
    } else if (remainMin < 30) {
      console.log(`token 剩余 ${remainMin} 分钟，即将续期`);
    } else {
      console.log(`token 剩余 ${remainMin} 分钟`);
    }
  } else {
    console.log('尚未登录，请运行 node refresh-token.js login');
  }
  // 等登录/续期完成后再探测；单次后台运行，不阻塞请求。
  const discovery = createDiscoveryRunner({
    getCredentials: auth.getToken,
    probe: credentials => runModelDiscovery({
      upstreamUrl: config.upstream, token: credentials.token, cookie: credentials.cookie,
      tunnelMode: config.tunnelMode, configuredModel: config.model,
    }),
    publish: results => {
      modelRegistry.publish(results);
      console.log('模型状态');
      for (const line of formatModelTable(results)) console.log(line);
      const target = results.find(r => r.id === config.model);
      if (target && !target.ok) {
        console.log(describeProbeFailure(target.reason, config.model) +
          (target.detail ? `（${target.detail}）` : ''));
      } else if (!target) {
        console.log(`未探测到 ${config.model}，客户端请使用 /v1/models 列出的模型名`);
      }
    },
  });
  const tick = () => discovery.tick().then(() => {
    if (discovery.complete) clearInterval(discoveryTimer);
  });
  const discoveryTimer = setInterval(tick, 2000);
  discoveryTimer.unref();
  httpServer.server.once('close', () => clearInterval(discoveryTimer));
  void tick();
});

// 探测上游有哪些模型可用。候选来自两处并集:
//   ① 上游前端 bundle 的 modelList(权威清单,还带 supportImage 等能力标注)
//   ② config 配置的目标模型(兜底——bundle 解析失败或清单漏了它时仍能验证)
// bundle 取不到(改版/网络)不致命:退回只探活配置的那个模型
async function runModelDiscovery({ upstreamUrl, token, cookie, tunnelMode, configuredModel }) {
  const candidates = new Map(); // id → meta|null

  // ① 上游首页 → bundle 路径 → bundle 内容 → modelList。
  // 超时刻意短(各 5s):这段是**锦上添花**(只为拿能力标注),拿不到就退回
  // 只探活配置的模型。校外用户走隧道访问直连域可能不可达——若给长超时,
  // 多数用户每次启动都要白等(2026-09-27 审阅指出);宁可少拿标注也不拖慢启动
  try {
    const home = await fetch(`${MADMODEL_WEB}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (home.ok) {
      const html = await home.text();
      const m = /src="([^"]*index-[^"]*\.js[^"]*)"/.exec(html);
      if (m) {
        const js = await fetch(new URL(m[1], MADMODEL_WEB).href, { signal: AbortSignal.timeout(5000) });
        if (js.ok) {
          for (const item of parseModelList(await js.text()) || []) candidates.set(item.id, item);
        }
      }
    }
  } catch (e) { /* bundle 取不到:退回只探 config 里的模型 */ }

  // ② 配置的目标模型始终参与探测(即便它已不在清单里——那正是要报告的形态)
  if (!candidates.has(configuredModel)) candidates.set(configuredModel, null);

  // 候选封顶:上游清单若异常膨胀(改版/被投毒),不把启动变成一场对上游的
  // 并发风暴。目标模型已在集合里,截断只影响"额外发现"的部分
  const MAX_CANDIDATES = 12;
  const ids = [...candidates.keys()].slice(0, MAX_CANDIDATES);
  if (!ids.includes(configuredModel)) ids[ids.length - 1] = configuredModel;

  const results = await discoverModels({ upstreamUrl, candidates: ids, token, cookie, tunnelMode });
  // 把能力标注并回结果(bundle 拿到的才有)
  return results.map(r => ({ ...r, meta: candidates.get(r.id) || null }));
}
