# 贡献指南（CONTRIBUTING.md）

感谢你愿意为 madmodel-proxy 做贡献。零 npm 依赖、clone 即用，贡献门槛刻意压得很低。

## 开发环境

- Node.js 18.14 以上（`fetch` / `AbortController` 依赖这条版本线）
- Windows 10/11。凭据加密用 DPAPI，登录链实测于 Windows，完整功能仅 Windows
- 别改动 `.gitattributes`，它锁定了换行策略

## 安装与运行

```bat
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
:: 无需 npm install——零运行时依赖
node proxy.js          :: 或 start.cmd 单窗口模式
```

跑完整功能需要配凭据（`node refresh-token.js login`，要清华账号）；纯开发不需要。

## 验证改动

- 本地快速验证是 `node --check`（CI 的语法门跑的就是它，覆盖全部 .js）
- 改动 SSE 解析、错误处理、超时这类协议行为后，跑 `npm run smoke` 做真实流量冒烟，需要代理在线、有效 token、消耗少量配额
- PR 描述里写清楚改了什么行为、怎么验证的

## 提 Issue

报 bug 附上操作系统版本、Node 版本（`node -v`）和相关日志，注意先脱敏。上游行为类问题（错误翻译、SSE 帧型）附上代理访问日志里那一行和上游错误原文。登录链问题注明实测日期，学校端点改版会让协议失效，日期是排查的第一线索。

## 提 Pull Request

先开 issue 描述意图，避免撞车。然后分支、改代码、验证、提 PR。涉及协议行为的改动，合并前需要真实流量冒烟通过（维护者跑或你自证）。

## 不能提交的内容

- token 和密码。包括你本机 `token.json`、`creds.json` 的内容，以及日志截图里的 Bearer 头、学号、密码
- 真实请求体。对话内容是隐私，`DUMP_FAILED=1` 产生的 `last-failed-request.json` 绝不能入库
- 本地状态文件。`~/.madmodel-proxy/` 下的一切（`.gitignore` 有兜底，别绕过）

以上任何一项出现在 PR 里都会被直接拒绝。不确定时看 [SECURITY.md](SECURITY.md) 的数据流向表，或在 issue 里问。
