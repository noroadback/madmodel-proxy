# 贡献指南

感谢你愿意为 madmodel-proxy 做贡献。本项目无 npm 运行时依赖。

## 开发环境

- **Node.js**。最低 18.14，推荐 24；CI 在 18.14 / 20 / 24 上验证。
- **运行平台**。支持 Windows、macOS 和 Linux，凭据分别使用 DPAPI、登录钥匙串和机器绑定加密。登录链已在 Windows 实测，macOS 和 Linux 的存储与启动路径由 CI 冒烟覆盖，欢迎补充实机验证。
- **文件格式**。保留 `.gitattributes` 中的换行约定。

## 安装与运行

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
npm start
```

使用完整功能前，运行 `npm run login` 配置清华大学统一认证凭据；离线开发和测试不需要真实凭据。

## 验证改动

- **离线测试**。运行 `npm test`，覆盖单元测试与替身上游集成测试。CI 在 Ubuntu 上使用 Node.js 18.14 / 20 / 24 运行完整测试；18.14 按文件执行，以绕过该版本的 TAP 解析器问题。
- **平台检查**。运行 `node scripts/platform-smoke.js`，验证存储与启动路径。测试使用独立状态目录和钥匙串命名空间，不读取真实凭据或访问学校服务；CI 在三个平台上使用 Node.js 24 执行。
- **真实验证**。改动 SSE 解析、错误处理或超时等协议行为后，运行 `npm run smoke` 检查真实网关响应。需要代理在线和有效 token，会消耗配额。
- **发布检查**。运行 `npm run check:release`，检查待发布文件，新增源码必须已纳入 Git。审阅未暂存改动时可用 `node scripts/release-check.js --worktree`；该模式仅检查工作区，不能证明提交内容已验证。
- **验证记录**。在 PR 描述中写明行为变化、执行的检查及结果。

新测试在加载产品模块前调用 `require('../scripts/isolated-env').isolate()`。子进程用 `createTestEnv()` 创建环境，避免继承用户的凭据路径、上游地址或钥匙串配置。

## 提 Issue

反馈问题时，附上操作系统版本、Node.js 版本（`node -v`）、故障时间和脱敏日志。上游行为问题附上对应的代理日志与脱敏后的上游错误；登录链问题注明实测日期，便于对照学校服务变化。工具参数或网络故障可按[故障取证](docs/DIAGNOSTICS.md)提供对应诊断编号的记录。

## 提 Pull Request

较大改动建议先开 issue 说明意图，再创建分支并提交 PR。涉及协议行为的改动，合并前需要真实流量冒烟通过（维护者跑或你自证）。

## 不能提交的内容

- **凭据**。包括本机 `token.json`、`creds.json` 的内容，以及日志或截图里的 Bearer 头、学号和密码。
- **真实请求体**。包括对话、图片和工具参数正文，以及 `DUMP_FAILED=1` 产生的 `last-failed-request.json`。
- **状态与诊断文件**。包括 `~/.madmodel-proxy/` 中的文件、故障取证记录和其他本地运行日志。不要绕过 `.gitignore` 的防护规则。

提交前请检查 diff。不确定时看 [SECURITY.md](SECURITY.md) 的数据流向表，或在 issue 里问。
