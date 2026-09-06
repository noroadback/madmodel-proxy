// proxy.js
// madmodel DeepSeek-V4-Flash 本地反向代理(OpenAI 兼容)的启动入口。
// 监听 127.0.0.1:8080,供 dsh 等标准 OpenAI 客户端使用。
//
// 职责(按已验证的 API 规格书):
//   1. token 热加载:每请求读 ~/.dsh-madmodel/token.json(watch 守护续期,免重启)
//   2. 强制上游 stream:true 绕 60s nginx 非流式超时;客户端要非流式时自己聚合 SSE
//   3. 错误翻译:上游错误统一翻译为标准 4xx/5xx;流截断(EOF 无 [DONE])按 502/
//      断流处理,不聚合成假成功
//   4. 伪造 GET /v1/models(上游不存在该端点,返回 SPA HTML)
//   5. 预检:body > 950KB 提前 413(nginx 1MB 硬限,留余量)
//   6. 并发不受业务层限制(多子代理编排是合法负载;实测上游 ≥24 并发流无压力),
//      资源兜底靠 server.maxConnections 与各级超时/字节上限(见 README 安全设计)
//   7. 本机安全边界:Host 白名单 + Bearer 鉴权 + 各级限额与超时(见 README 安全设计)
//
// 架构分层:core/(业务与协议,无平台依赖) + adapters/(HTTP 适配) +
// platform/(DPAPI/路径/原子文件/进程锁)。环境变量清单见 README 配置表。
//
// 用法: node proxy.js  (Ctrl+C 退出)

'use strict';

const config = require('./config');
const { createUpstreamClient } = require('./core/upstream-client');
const { createProxyService } = require('./core/proxy-service');
const { createHttpServer } = require('./adapters/http-server');
const paths = require('./platform/paths');

const service = createProxyService({
  config,
  tokenState: () => httpServer.auth.tokenState(),
  upstreamClient: createUpstreamClient(config),
});
const httpServer = createHttpServer({ config, service });

process.on('unhandledRejection', e => {
  // 长驻进程:记日志不退出,单次请求的异常不应拖垮整个代理。
  // 只打 message:堆栈含本机绝对路径,控制台输出常被贴进 issue
  console.error(`[${new Date().toTimeString().slice(0, 8)}] [unhandledRejection]`,
    e?.message || e);
});
process.on('uncaughtException', e => {
  // 同步异常的最后防线:记一行后退出,由 dashboard 自动重启接管(无 dashboard
  // 时用户重开 start.cmd)。比带着损坏状态继续服务更安全
  console.error(`[${new Date().toTimeString().slice(0, 8)}] [uncaughtException]`,
    e?.message || e);
  process.exit(1);
});

httpServer.server.listen(config.port, config.host, () => {
  const auth = httpServer.auth;
  console.log(`madmodel 反代已启动: http://${config.host}:${config.port}/v1`);
  console.log(`模型: ${config.models.join(', ')}`);
  if (auth.apiKey) {
    console.log(`本地鉴权: 已启用(${auth.keyEnv ? '环境变量 PROXY_API_KEY 指定' : auth.keyGenerated ? '本次生成随机 key' : '复用已有'}` +
      (auth.keyPersisted ? '' : ',⚠ 落盘失败,使用进程内临时 key') +
      `,客户端 Bearer key 见: ${paths.display(paths.KEY_FILE)})`);
  } else {
    console.log('⚠ 本地鉴权已关闭(PROXY_NO_AUTH=1):恶意网页可盲调本代理消耗配额,仅限测试' +
      (auth.keyEnvOverridden ? ';注意:PROXY_API_KEY 已设置但被 NO_AUTH 覆盖,不参与鉴权' : ''));
  }
  console.log(`token 文件: ${paths.display(paths.TOKEN_FILE)}(热加载,续期免重启)`);
  const t = auth.getToken();
  if (t) {
    const remainMin = Math.round((t.expiresAt - Date.now()) / 60e3);
    if (remainMin <= 0) {
      // 启动竞态:start.cmd 同时拉起 watch 与代理,代理先读到的是续期前的旧 token
      console.log(`⚠ token 已过期 ${-remainMin} 分钟。若 watch 守护刚随本代理启动,` +
        '续期通常在半分钟内完成(完成时此处会追加"token 已热加载"日志,期间请求短暂 401);' +
        '若 watch 未运行,请通过 start.cmd 启动');
    } else if (remainMin < 30) {
      console.log(`当前 token 剩余 ${remainMin} 分钟(即将进入续期窗口)`);
    } else {
      console.log(`当前 token 剩余 ${remainMin} 分钟`);
    }
  } else {
    console.log('⚠ 尚无 token,请先: node refresh-token.js login');
  }
});
