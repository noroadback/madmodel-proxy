# madmodel-proxy

把清华 madmodel 变成本机一个配好就不用管的 OpenAI 端点。login 一次、双击 start.cmd，token 的获取、续期、轮转全归它管，你的客户端只认 `http://127.0.0.1:8080/v1`。

## 三步开始

前置是 Windows 10/11、Node.js ≥ 18.14 和一个清华统一认证账号。

```bat
cd %USERPROFILE%
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy

rem 1. 首次配置:输入学号+密码(首次含二次认证,只需一次)
node refresh-token.js login
```

然后双击 **start.cmd** 启动（资源管理器里双击即可；在 PowerShell 里运行要写 `.\start.cmd`，CMD 里 `start.cmd` 即可）。首次启动会问你要不要在桌面建快捷方式，按 Y 之后开机从桌面双击启动，窗口最小化挂着就行。

想看运行状态时，再双击一次桌面图标（或 start.cmd）即可——服务在跑就会显示一屏体检（代理/token/续期守护/凭据），不会重复启动；命令行形态是 `node refresh-token.js status`。

然后在你的智能体里填这几个值。

| 配置项 | 值 |
|---|---|
| 协议类型 | **Chat / Chat Completions**（别选 Anthropic/Responses/Gemini Native，那些是别家协议） |
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 随便填（本地无鉴权，界面要求非空就填 `none`） |
| 模型 | `DeepSeek-V4-Flash` |

dsh / codex / claude code 找配置文件里的 `base_url` + `model`；Cherry Studio / ChatBox / CCS 这类带"添加供应商"的客户端，选"OpenAI"或"自定义/OpenAI 兼容"类型填上面四个值（模型列表可点"获取"拉取）；代码调用是 `new OpenAI({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'none' })`。模型列表拉不出来就是 Base URL 的 `/v1` 多带或少带了。

详细步骤与故障排查见 [docs/connect-dsh.md](docs/connect-dsh.md)。

## 它解决了什么

madmodel 本身有 OpenAI 格式的 API，但直接连客户端会撞上两件事。

**token 烦**。官方 key 只有 5 小时有效期，获取方式是网页登录手动复制。重度使用意味着每天数次打断。本工具用统一认证链自动续期，到期前 30 分钟换新，代理热加载，客户端无感。

**行为怪**（2026-09 直连实测）。非流式请求 60 秒整被网关掐断；WAF 误拦含工具语法的请求体；一切错误包在 `HTTP 200` 里返回"服务器繁忙"；`/v1/models` 返回网页 HTML。本工具在代理层逐项适配，对上游恒以流式请求、客户端要非流式就聚合，错误翻译回真实状态码。

## 特性

- **零依赖**。纯 Node 原生，clone 即用，无 `npm install`
- **token 全自动**。到期前 30 分钟自动走完整登录链（含二次认证、可信设备登记），热加载免重启
- **DPAPI 加密**。密码与 token 静态加密存储，仅当前 Windows 账户可解
- **单窗口运行**。start.cmd 同窗拉起守护与代理，Ctrl+C 或关窗全停
- **真实 usage**。代理注入 `include_usage`，客户端拿到真实 token 计数

## 边界

- **Windows 专用**。凭据存储依赖 DPAPI，Linux/macOS 跑不了代理与续期
- **清华 madmodel 专用**。登录链实测于 2026-09，学校改版即失效（失效会报明确错误）
- **本地无鉴权**。安全边界是只监听 `127.0.0.1` + Host 白名单，客户端 API key 随便填
- **只有 chat completions**。无 embeddings、图像、音频；单模型，任意模型名都会被重写为 `DeepSeek-V4-Flash`；`logprobs`/`n>1` 被剥离（上游拒绝）

## 常见问题

| 现象 | 处理 |
|---|---|
| 请求 401 `token 已过期` | watch 守护没在跑或续期失败。`node refresh-token.js status` 一屏看清；没跑就开 start.cmd |
| 启动报 `端口 8080 已被占用` | 代理已在跑（start.cmd 重复双击），直接用；要另开实例用 `PROXY_PORT` |
| 上游 401/502/429 | 上游侧问题，通常自愈；持续出现提 issue 附代理日志 |
| token 长期无人续期 | 改过密码或二次认证过期，重跑一次 `node refresh-token.js login` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_PORT` | `8080` | 监听端口 |
| `PROXY_NO_GZIP` | 关 | `=1` 关闭请求体 gzip 编码（上游 WAF 误报规避） |
| `PROXY_REFRESH_AHEAD_MS` | 1800000 | 提前续期窗口（毫秒） |
| `PROXY_STREAM_TOTAL_MS` | 1200000 | 单次流式请求总时限（毫秒） |
| `DUMP_FAILED` | 关 | `=1` 时被上游拒绝的请求体落盘，含完整对话（隐私），排障后删 |

其余调度类变量与测试注入变量见源码 `config.js` 注释。

## 更多

- 详细接入指南与故障排查，见 [docs/connect-dsh.md](docs/connect-dsh.md)。
- 上游实测行为与设计取舍，见 [CHANGELOG.md](CHANGELOG.md)。
- 数据流向与安全边界，见 [SECURITY.md](SECURITY.md)。
- 参与贡献，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 改动协议行为后的验证用 `npm run smoke`，它是真实流量冒烟（需 token，消耗少量配额）。

本工具仅供清华大学师生在遵守学校相关规定的前提下个人使用，不提供配额共享，请勿用于服务他人的用途。

## 许可证

[MIT](LICENSE)
