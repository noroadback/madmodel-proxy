# madmodel-proxy

把清华的 DeepSeek 服务（[madmodel.cs.tsinghua.edu.cn](https://madmodel.cs.tsinghua.edu.cn/)）变成本地 OpenAI 端点。token 过期自动续期，上游接口的兼容性问题在代理层处理，客户端只需连 `http://127.0.0.1:8080/v1`。

## 使用

前置是 Windows、macOS 或 Linux，Node.js ≥ 18.14，以及一个清华统一认证账号。

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy

# 首次配置:输入学号+密码(首次含二次认证,只需一次)
node refresh-token.js login
```

第一次登录大概率遇到二次认证（新设备验证）：终端列出可用验证方式（微信 / 短信 / TOTP），选一个输六位验证码；通过后本机登记为可信设备，之后的自动续期不再需要。凭据静态加密存于 `%USERPROFILE%\.madmodel-proxy\`（macOS / Linux 为 `~/.madmodel-proxy/`），加密形态与数据流向见 [SECURITY.md](SECURITY.md)。

Windows 双击 **start.cmd** 启动（首次会问是否创建桌面快捷方式；代理已在运行时再次运行会显示状态，不会重复启动），macOS / Linux 运行 `npm start`。窗口保持开启。启动成功的标志是下面这样的输出：

```
[watch] madmodel token 自动续期守护进程已启动(PID 12345)
[代理] madmodel 本地端点已启动: http://127.0.0.1:8080/v1
[代理] 当前 token 剩余 272 分钟
```

在客户端（智能体、OpenAI SDK）里填以下值。

| 配置项 | 值 |
|---|---|
| 协议 | Chat Completions |
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 任意值（本地无鉴权） |
| 模型 | `DeepSeek-V4-Flash-0731` |

客户端要求填写上下文长度时填 `262144`（学校部署的实际值）。不要按官方 DeepSeek 规格配置——部分客户端会自动匹配到官方的 1M 上下文，长会话会越过上限。输出上限（max_tokens）按客户端默认即可：`prompt + max_tokens` 超出 262,144 时代理自动把输出预算收缩到剩余空间再发，仅极长输出需要续写。

## 为什么需要它

madmodel 本身有 OpenAI 格式的 API，但直接连客户端会撞上两件事。

**token 有效期短**。key 只有 5 小时有效期，只能网页登录后手动复制，重度使用一天要重复数次。本工具用统一认证链自动续期，到期前 30 分钟换新，代理热加载。

**接口行为与客户端预期不符**。非流式请求 60 秒整被网关掐断；错误都以 `HTTP 200` 返回"服务器繁忙"；`/v1/models` 返回网页 HTML（以上为 2026-09 直连实测）。本工具在代理层逐项适配，对上游恒以流式请求、客户端要非流式就聚合，错误翻译回真实状态码。

## 特性

- **零依赖**。纯 Node 原生，clone 即用，无 `npm install`
- **token 全自动**。到期前 30 分钟自动走完整登录链（含二次认证、可信设备登记），热加载免重启
- **本地精确分词**。内置 DeepSeek 公开分词器（与学校部署逐 token 一致，24 万 token 级实测校准），按上游同一规则（`prompt+max_tokens ≤ 262,144`）预检；`max_tokens` 超限时自动收缩到剩余空间放行（输出上限而非目标，收缩无感），仅 prompt 本身超限才 413
- **静态加密存储**。Windows 用 DPAPI、macOS 用登录钥匙串、Linux 用机器绑定加密
- **单窗口运行**。Windows 双击 start.cmd、macOS / Linux 用 `npm start`，同窗拉起守护与代理，Ctrl+C 或关窗全停

## 边界

- **本地无鉴权**。只监听 `127.0.0.1` + Host 白名单，客户端 API key 填任意值
- **只有 chat completions**。无 embeddings、图像、音频；单模型，任意模型名都会被重写为 `DeepSeek-V4-Flash-0731`；`logprobs`/`n>1` 被剥离（上游拒绝）；`max_tokens` 收敛到 [512, 65536]（下限仅思考开启时生效）

## 常见问题

| 现象 | 处理 |
|---|---|
| 请求 401 `token 已过期` | watch 守护没在跑或续期失败。`node refresh-token.js status` 一屏看清；没跑就开 start.cmd 或 `npm start` |
| 请求 503 | 本地无 token。没做过 login，或 `[watch]` 日志有报错 |
| 请求 413 上下文超限 | 会话接近 262,144 tokens 上限（`max_tokens` 已被代理自动收缩过仍不够）。新开会话，或让客户端压缩 history |
| 启动报 `端口 8080 已被占用` | 代理已在运行，直接使用；需另开实例时用 `PROXY_PORT` |
| 上游 401/502/429 | 上游侧问题，通常自愈；持续出现提 issue 附代理日志 |
| token 长期无人续期 | 改过密码或二次认证过期，重跑一次 `node refresh-token.js login` |
| 仓库文件夹丢失 | 重新 clone 即可，登录状态不丢：状态目录（`~/.madmodel-proxy/`）与仓库分离 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_PORT` | `8080` | 监听端口 |
| `PROXY_REFRESH_AHEAD_MS` | 1800000 | 提前续期窗口（毫秒） |
| `PROXY_NO_TOKEN_WAIT_MS` | 60000 | watch 守护未配置凭据时的重查间隔（毫秒） |
| `PROXY_MAX_SLEEP_MS` | 3600000 | watch 守护单次等待上限（毫秒），到点醒来重读 token 状态 |
| `PROXY_STREAM_TOTAL_MS` | 1200000 | 单次流式请求总时限（毫秒） |
| `PROXY_NONSTREAM_TOTAL_MS` | 600000 | 非流式请求聚合总时限（毫秒） |
| `DUMP_FAILED` | 关 | `=1` 时被上游拒绝的请求体落盘，含完整对话（隐私），排障后删 |

## 更多

- 上游实测行为与设计取舍，见 [CHANGELOG.md](CHANGELOG.md)。
- 数据流向与安全边界，见 [SECURITY.md](SECURITY.md)。
- 参与贡献，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本工具仅供清华大学师生在遵守学校相关规定的前提下个人使用，不提供配额共享，请勿用于服务他人的用途。

## 许可证

[MIT](LICENSE)
