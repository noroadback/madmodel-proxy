# 贡献指南（CONTRIBUTING.md）

感谢你愿意为 madmodel-proxy 做贡献。零 npm 依赖、clone 即用、`npm test` 全程离线，贡献门槛刻意压得很低。

## 开发环境

- Node.js 18.14 以上（`fetch` / `AbortController` 依赖这条版本线，CI 在 18/20/22/24 上跑测试）
- Windows 10/11。凭据加密用 DPAPI，登录链实测于 Windows。Linux/macOS 上 `npm test` 仍可运行（DPAPI 部分自识别跳过），但完整功能仅 Windows
- 别改动 `.gitattributes`，它锁定了换行策略

## 安装与运行

```bat
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
:: 无需 npm install——零运行时依赖
node proxy.js          :: 或 start.cmd 单窗口模式
```

跑完整功能需要配凭据（`node refresh-token.js login`，要清华账号）；纯开发和跑测试不需要。

## 测试

```bat
npm test
```

全程离线，不碰真实上游、不要账号、不耗配额，任何网络环境都能跑，失败以非零退出码结束。套件分三层，`test-creds.js` 做 DPAPI 往返，`node --test` 跑单元测试，`test-proxy.js` 起假上游加子进程做端到端。

`npm run smoke` 是另一回事。它是真实流量冒烟，要代理在线、有效 token、消耗少量配额，只在改动 SSE 解析、错误处理、超时这类协议行为后才需要跑。

## 添加单元测试

- 用 Node 原生 `node:test` 加 `node:assert/strict`，放仓库根目录，命名 `test-<模块名>.js`
- 纯逻辑模块直接 `require` 被测对象，不起网络、不碰文件系统（临时目录除外）
- 涉及 HTTP 的模块用 `http.createServer` 在 127.0.0.1 随机端口起假上游，测试结束 `server.close()`
- 涉及环境变量的模块用 `child_process.execFile` 起子进程隔离 `process.env`。`config.js` 在 require 时读环境，同进程内没法重置
- 新文件记得加进 `package.json` 的 `test` 脚本列表
- `test-proxy.js` 的用例以子进程方式注入环境变量，入口文件名（`proxy.js` / `refresh-token.js`）不能改

## 提 Issue

报 bug 附上操作系统版本、Node 版本（`node -v`）和相关日志，注意先脱敏。上游行为类问题（错误翻译、SSE 帧型）附上代理访问日志里那一行和上游错误原文。登录链问题注明实测日期，学校端点改版会让协议失效，日期是排查的第一线索。

## 提 Pull Request

先开 issue 描述意图，避免撞车。然后分支、改代码、`npm test` 全绿、提 PR，描述里写清楚改了什么行为、怎么验证的。涉及协议行为的改动，合并前需要真实流量冒烟通过（维护者跑或你自证）。

## 不能提交的内容

- token 和密码。包括你本机 `token.json`、`creds.json` 的内容，以及日志截图里的 Bearer 头、学号、密码
- 真实请求体。对话内容是隐私，`DUMP_FAILED=1` 产生的 `last-failed-request.json` 绝不能入库
- 本地状态文件。`~/.dsh-madmodel/` 下的一切（`.gitignore` 有兜底，别绕过）
- 测试里的真实端点或账号。测试注入一律用 `PROXY_UPSTREAM` / `PROXY_TOKEN_FILE` / `MADMODEL_CREDS_FILE` 指向本地假对象

以上任何一项出现在 PR 里都会被直接拒绝。不确定时看 [SECURITY.md](SECURITY.md) 的数据流向表，或在 issue 里问。
