# madmodel-proxy

将[清华大学 DeepSeek 服务](https://madmodel.cs.tsinghua.edu.cn/)接入兼容 OpenAI Chat Completions 的客户端，并自动续期登录凭据。需要清华大学统一认证账号。

支持 Windows、macOS 和 Linux。推荐 [Node.js 24 LTS](https://nodejs.org/)，最低 18.14；无需 `npm install`。

[快速开始](#快速开始) · [模型配置](#模型配置) · [日常使用](#日常使用) · [常见问题](#常见问题) · [更新](#更新) · [高级配置](#高级配置)

## 快速开始

安装 Node.js 后，在终端执行：

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
npm run login
npm start
```

按提示完成统一认证，必要时完成二次认证。首次启动选择网络方式：校园网内选直连，校外或不确定时选 WebVPN。选择会保存，日常只需 `npm start`。

在客户端填写：

| 配置项 | 值 |
|---|---|
| API 类型 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 默认可填 `local`；开启鉴权后填写配置的密钥 |
| 模型 | 获取列表后选择，或手填下方的模型 ID |

客户端需支持自定义 Base URL 和 Chat Completions；仅支持 Responses 接口的配置无法直接接入。

<details>
<summary>没有 Git，或使用 Windows</summary>

- **没有 Git**：在仓库页面选择 **Code → Download ZIP**，解压后在项目目录打开终端，从 `npm run login` 开始。
- **Windows 登录**：建议使用 PowerShell 或 CMD；无法确认密码隐藏的 Git Bash 终端会提示更换终端。
- **Windows 启动**：登录后可双击 `start.cmd`，或运行 `create-shortcut.cmd` 创建桌面快捷方式。

</details>

## 模型配置

优先在客户端获取模型列表；不支持获取时，完整复制以下 ID。

| 模型 ID | 输入 |
|---|---|
| `DeepSeek-V4.1-Flash` | 文字、图片 |
| `qwen3.8-27b` | 文字、图片、视频 |
| `DeepSeek-R1-W8A8` | 文字 |

根据学校服务公告，DeepSeek-V4.1-Flash 已于 10 月 18 日完成升级，现由 `deepseek-v4.1-flash-1017` 版本提供服务；调用方式保持不变，无需修改任何配置。媒体能力来自 2026-09-30 实测，工具调用、思考开关与响应字段于 2026-10-18 在 1017 部署上复核。客户端也需支持发送对应媒体。

- **工具调用**。DeepSeek V4.1 和 Qwen 支持原生调用，R1 实测未返回原生调用。
- **思考**。DeepSeek V4.1 和 Qwen 默认开启，可用 `reasoning_effort: "none"` 关闭。R1 无法关闭，只接受 `low` / `medium` / `high`。
- **响应模型名**。上游在响应里回显部署名（2026-10-18 实测为 `deepseek-v4.1-flash-1017`），与请求用的模型 ID 不同。严格比对两者是否相同的客户端会看到差异。
- **用量字段**。DeepSeek 的 `usage.prompt_tokens_details` 在含图请求中会给出 `image_tokens`，命中前缀缓存时会给出 `cached_tokens`；纯文本或未命中缓存时该对象仍可能为 `null`。Qwen 只返回 `prompt_tokens`。

学校可能调整模型名称和能力，代理会在凭据有效后自动探测。默认配置下也可打开[本机模型列表](http://127.0.0.1:8080/v1/models)；修改端口后同步修改地址，开启鉴权后请通过客户端获取。

<details>
<summary>上下文与输出预算</summary>

以下为当前代理配置，单位为 token。客户端选择流式或非流式时，均使用同一预算。

| 模型 | 上下文上限 | 输出预算上限 |
|---|---:|---:|
| DeepSeek V4.1 | 1,048,576 | 1,048,576 |
| Qwen | 262,144 | 262,000 |
| R1 | 163,840 | 163,840 |

输入与输出共享上下文，代理按输入占用和预留余量下调过大的输出预算。图片估值不会单独触发本地拒绝；表中预算不保证实际生成长度。计量规则、上游限制与实测记录见[预算说明](docs/TOKEN-BUDGET.md)。

</details>

## 日常使用

保持运行窗口开启，按 Ctrl+C 停止。自动续期成功后无需重启；学校要求重新认证时，再运行 `npm run login`。

以下命令在项目目录的另一个终端中执行：

| 操作 | 命令 |
|---|---|
| 查看状态 | `npm run status` |
| 重新登录或更新密码 | `npm run login` |
| 手动续期一次 | `npm run once` |
| 清除本机凭据（先停止服务） | `node refresh-token.js logout` |

日志记录上游实际 token 用量，有明细时附加图片和缓存计数；这些明细已包含在输入总量中，不重复累计。未返回的用量保持未知，累计值在代理重启后归零。首字按代理收到首个思考、正文或工具调用计时；均速包含等待。

凭据默认保存在 `~/.madmodel-proxy/`，与项目目录分开；`logout` 不撤销学校侧会话。服务默认仅监听本机且不校验 API Key，同机能访问端口的程序和用户均可调用。开启鉴权或供其他设备访问，见[局域网部署](docs/DEPLOY-LAN.md)；存储方式与数据流向见[安全说明](SECURITY.md)。

### 校内 / 校外切换

在运行窗口输入 `campus` 切到校园网直连，输入 `offcampus` 切到 WebVPN，回车生效。切换会重启服务并保存选择，未完成的请求需重试。

Windows 也可运行 `.\start.cmd campus` / `.\start.cmd offcampus`。服务已运行时，这两个命令只保存选择，下次启动生效。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 连接被拒绝 | 运行 `npm run status`，确认代理已启动，客户端端口一致 |
| 端口被占用 | 检查是否已有代理运行；换端口时设置 `PROXY_PORT`，并同步修改客户端地址 |
| API Key 缺失或无效 | 开启鉴权后需填写服务端配置的密钥 |
| token 过期或 401 | 确认 watch 在运行，等待自动续期；持续失败时运行 `npm run login` |
| 模型不存在 | 重启代理并重新获取模型列表，更新客户端选择 |
| 无法添加图片 | 检查客户端是否支持图片，并开启对应模型的图片输入选项 |
| “服务器繁忙”或 429 | 降低并发，稍后重试；持续失败时用短对话和默认参数验证 |
| 400，上下文超限 | 缩短对话、减少历史图片或降低输出上限 |
| 413 | 减少图片或缩短对话；本地请求体默认上限为 64 MiB，上游另有限制，具体见报错 |
| 502、504 或回复中断 | 尝试缩短对话或切换网络；校外请使用 `offcampus` |
| 工具未执行 | 使用支持工具的模型，确认客户端提供并允许调用工具，检查是否等待执行确认 |

## 更新

先停止服务，提交或备份自己修改的项目文件，再执行 `git pull` 并重新启动。升级后在客户端重新获取模型列表。

ZIP 用户请解压到新目录，并重新创建桌面快捷方式。同一系统账户下通常可沿用默认凭据；自定义状态目录需继续使用原路径。版本检查只提示，不会自动更新文件。

## 高级配置

环境变量在启动前设置，修改后重启生效。以更换端口为例，客户端地址也需改为 `http://127.0.0.1:8081/v1`。

<details>
<summary>修改端口示例</summary>

PowerShell：

```powershell
$env:PROXY_PORT = "8081"
npm start
```

macOS / Linux：

```sh
PROXY_PORT=8081 npm start
```

</details>

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_PORT` | `8080` | 本地端口 |
| `PROXY_UPSTREAM` | 按网络选择 | 完整上游 Chat Completions URL |
| `PROXY_BIND_HOST` | `127.0.0.1` | 监听地址；非回环地址必须配置密钥 |
| `PROXY_API_KEYS` | 未设置 | 逗号分隔的访问密钥 |
| `PROXY_BODY_LIMIT_MB` | `64` | 请求体上限，单位 MiB，包含图片数据 |
| `PROXY_BODY_BUDGET_MB` | `256` | 上传和处理中请求体的总量预算，单位 MiB，至少为单请求上限 |
| `PROXY_NO_UPDATE_CHECK` | 未设置 | `1` 关闭启动时的版本检查 |
| `MADMODEL_STATE_DIR` | `~/.madmodel-proxy/` | 凭据与状态目录 |

`PROXY_UPSTREAM` 会接收对话和 Bearer token，仅配置可信服务。该变量在启动时优先于网络选择；运行窗口中的 `campus` / `offcampus` 可覆盖当前地址，下次启动仍以环境变量为准。

请求体总量按原始 JSON 字节计量，额度保留到请求处理结束，容量不足时返回 429。解析、转发和分词另有内存开销，该预算不代表进程内存上限。

<details>
<summary>超时、续期与排障参数</summary>

时间参数单位为毫秒。长对话冷启动可能数分钟后才出首字，实际等待还受客户端与上游连接限制。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_HEADER_MS` | `300000` | 等待上游响应头 |
| `PROXY_IDLE_MS` | `300000` | 等待上游数据，包含首帧等待 |
| `PROXY_STREAM_TOTAL_MS` | `1200000` | 收到响应头后的响应体总时限 |
| `PROXY_NONSTREAM_TOTAL_MS` | `600000` | 非流式聚合总超时 |
| `PROXY_RETRY_WAIT_MS` | `30000` | WebVPN 登录重定向后等待新凭据 |
| `PROXY_REFRESH_AHEAD_MS` | `1800000` | 到期前多久开始续期 |
| `PROXY_NO_TOKEN_WAIT_MS` | `60000` | 无可用 token 且未配置凭据时的检查间隔 |
| `PROXY_MAX_SLEEP_MS` | `3600000` | 续期调度单次等待上限 |
| `PROXY_KEEPALIVE_MS` | `1500000` | WebVPN 保活间隔 |
| `PROXY_DEBUG_BUDGET` | 未设置 | `1` 显示预算明细和输出上限调整 |
| `DUMP_FAILED` | 未设置 | `1` 保存部分上游失败请求 |

`DUMP_FAILED` 会将完整对话保存到状态目录的 `last-failed-request.json`，排障后请关闭并删除文件。

</details>

<details>
<summary>接口兼容说明</summary>

- **请求参数**。`max_completion_tokens` 转为 `max_tokens`；开启思考时，低于 512 的输出预算提升到 512。仅保留单个候选回复，不传递 `logprobs` / `top_logprobs`。
- **思考字段**。原生 `chat_template_kwargs` 优先于顶层思考参数。Qwen 的 `reasoning` 统一为 `reasoning_content`。
- **响应交付**。上游统一使用 SSE，非流式客户端由代理聚合。流式普通文字和思考直接转发；原生工具调用在上游正常结束、参数校验通过后交付，期间混合的正文可能暂存。合法调用若标记为 `stop`，修正为 `tool_calls`，其他结束原因保留。
- **错误处理**。上游明确报告的上下文超限返回 400 和 `context_length_exceeded`。上游断流或工具参数无效时不交付调用；已开始发送 SSE 后通过中断流反映错误，不补发 `[DONE]`。

</details>

## 更多

[更新记录](CHANGELOG.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE) · [第三方声明](THIRD-PARTY-NOTICES.md)

本项目为非官方客户端，学校服务或认证流程变化可能影响使用。
