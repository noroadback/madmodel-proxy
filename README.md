# madmodel-proxy

将清华大学 Deepseek 服务（[https://madmodel.cs.tsinghua.edu.cn/](https://madmodel.cs.tsinghua.edu.cn/)）接入支持 OpenAI Chat Completions 的本机客户端，并自动续期登录凭据。需要清华大学统一认证账号。

支持 Windows、macOS 和 Linux。推荐 [Node.js 24 LTS](https://nodejs.org/)，最低版本为 18.14；无需 `npm install`。

## 快速开始

安装 Node.js 后，在终端依次执行以下命令。

```sh
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
npm run login
npm start
```

没有 Git 时，在仓库页面选择 **Code → Download ZIP**，解压后在项目目录打开终端，从 `npm run login` 开始执行。

按提示输入学号、统一认证密码，必要时完成二次认证。登录成功后，日常只需 `npm start`。Windows 也可双击 **start.cmd**，或双击 `create-shortcut.cmd` 创建桌面快捷方式。

Windows 首次登录建议使用 PowerShell 或 CMD；无法确认密码隐藏的 Git Bash 终端会提示更换终端。

首次启动会询问网络方式，并记住选择。校园网内可选直连，校外或不确定时选 WebVPN 隧道。启动后会看到类似输出。

```text
[watch] 自动续期已启动
[代理] 服务已启动 http://127.0.0.1:8080/v1
```

在客户端填写以下配置。

| 配置项 | 值 |
|---|---|
| API 类型 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8080/v1` |
| API key | 任意非空值，例如 `local` |
| 模型 | 获取列表后选择；不支持获取列表时，复制下表中的模型 ID |

客户端需支持自定义 Base URL 和 Chat Completions。代理按所选模型转发请求；仅支持 Responses 接口的配置无法直接接入。

### 模型配置

无法获取模型列表时，在客户端选择“自定义模型”或手填 Model ID，完整复制以下名称。

| 模型 ID | 实测可用输入 |
|---|---|
| `DeepSeek-V4.1-Flash` | 文字、图片 |
| `qwen3.8-27b` | 文字、图片、视频 |
| `DeepSeek-R1-W8A8` | 文字 |

以上为 2026-09-30 经本代理的实测结果。

客户端需支持发送对应媒体。若需手动开启“图片输入”或“视觉”，可按上表设置；`supports_vision` 标记可能与实测不符。代理不提供独立的图像生成或语音接口。

学校可能调整模型名称和能力。代理会在凭据有效后自动探测；默认配置下可打开 [本机模型列表](http://127.0.0.1:8080/v1/models) 复制其中的 `id`，改过端口时同步替换地址。开启 API Key 鉴权后，请通过已配置密钥的客户端获取列表。

- **思考**。DeepSeek V4.1 和 Qwen 默认开启，可用 `reasoning_effort: "none"` 关闭。R1 无法关闭思考，上游只接受 `low` / `medium` / `high`；代理会移除 `none`，不会因此关闭 R1 思考。
- **工具调用**。DeepSeek V4.1 和 Qwen 支持原生调用；2026-10-17 的补测报告中，R1 静默忽略工具定义，未返回原生调用。必要时代理尝试文本恢复，最多额外请求一次；禁用工具时不补救。带工具的流式回复可能先显示思考，正文与完整工具参数等生成结束后再显示。
- **Qwen 乱码**。已加入缓解措施，可能增加首字等待时间，见 [1.10.1 更新记录](CHANGELOG.md#1101)。

<details>
<summary>上下文与输出预算（按需填写）</summary>

以下是当前代理配置，单位为 token。

| 模型 | 上下文上限 | 最大输出预算 |
|---|---:|---:|
| `DeepSeek-V4.1-Flash` | 1,048,576 | 1,048,576 |
| `qwen3.8-27b` | 262,144 | 262,000 |
| `DeepSeek-R1-W8A8` | 163,840 | 163,840（共享窗口预算） |

输入与输出共享上下文，代理按文本、工具和图片估值下调过大的输出预算。图片估值不会单独触发本地拒绝，实际是否超限由上游判断。表中数值不保证单次生成长度。

2026-10-17 的补测报告确认 R1 窗口为 163,840，`max_tokens: 160000` 可接受；163,832 加 8 token 输入已被拒绝，因此不能把 163,832 当作固定输出上限。代理以共享窗口为预算天花板，再扣除输入与余量，详见[预算说明](docs/TOKEN-BUDGET.md)。

Qwen 的 262,000 输出预算仅适用于上游流式接口；直连上游非流式接口的上限为 131,072。代理常规请求统一走 SSE，因此客户端选择非流式也可使用表中预算；额外的非流式工具补救会将输出预算收缩到最多 131,072。

</details>

## 日常使用

保持运行窗口开启，按 Ctrl+C 停止。自动续期成功后无需重启；学校要求重新认证时，再运行一次 `npm run login`。

以下命令在项目目录的另一个终端中执行。

| 操作 | 命令 |
|---|---|
| 查看运行状态 | `npm run status` |
| 重新登录或更新密码 | `npm run login` |
| 手动续期一次 | `npm run once` |
| 清除本机凭据，先停止服务 | `node refresh-token.js logout` |

日志中的 `token 输入数/输出数` 来自上游，累计值在代理进程重启后归零；未返回的用量不估算。“工具调用”表示已交给客户端的调用数量，执行结果由客户端决定。

预算检查与输出上限调整在后台执行，日常日志不显示预算明细。排障时可在启动前设置 `PROXY_DEBUG_BUDGET=1`，查看预算估算和输出上限调整。

凭据默认保存在 `~/.madmodel-proxy/`，与项目目录分开。`logout` 清除本机凭据，不撤销学校侧的会话。服务默认仅监听 `127.0.0.1`，不校验本地 API key；能访问该端口的程序及同机其他用户均可调用。可按 [局域网部署说明](docs/DEPLOY-LAN.md) 开启 API Key 鉴权或供其他设备访问。存储方式与数据流向见 [安全说明](SECURITY.md)。

### 校内 / 校外切换

在运行窗口输入 `campus` 切到校园网直连，输入 `offcampus` 切到校外 WebVPN 隧道，回车生效。

切换会重启服务并保存选择，未完成的请求需重试。离开校园网后请求失败，可先切到 `offcampus`；网络可达性仍取决于学校当前策略。

Windows 也可运行 `.\start.cmd campus` / `.\start.cmd offcampus`。服务已运行时，这两个命令只保存选择，下次启动生效。设置了 `PROXY_UPSTREAM` 时，启动以该变量为准。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 连接被拒绝 | 运行 `npm run status`，确认代理已启动，客户端端口一致 |
| 端口已被占用 | 确认是否已有代理运行；需要换端口时设置 `PROXY_PORT`，并同步修改客户端地址 |
| 换网络后请求失败 | 在原运行窗口输入 `offcampus` 并回车，切换后重试 |
| API Key 缺失或无效 | 填写服务端配置的密钥；开启鉴权后不能再填任意值 |
| token 过期或上游返回 401 | 确认 watch 在运行，等待自动续期；持续失败时运行 `npm run login` |
| 尚未登录、改密码或需二次认证 | 在另一个终端运行 `npm run login`，按提示完成认证 |
| 模型不存在 | 重启代理后重新获取模型列表，更新客户端选择 |
| 客户端不能获取模型列表 | 手填上表的模型 ID；未开启鉴权时也可在浏览器打开本机 `/v1/models` 查询 |
| 无法添加图片 | 检查客户端的图片输入开关；若客户端支持手动设置视觉能力，可按前面的能力表启用 |
| “服务器繁忙”或 429 | 降低并发，稍后重试；持续失败时用短对话和默认参数验证，也可能是参数不兼容或请求超限 |
| 400，上下文超限 | 缩短对话、减少历史图片或降低输出上限；代理保留上游的 400 状态，并提供 `context_length_exceeded` 错误码 |
| 413 | 减少图片或缩短对话。本地请求体默认上限为 64 MiB，可用 `PROXY_BODY_LIMIT_MB` 调整；上游另有限制，具体原因见报错 |
| 502、504 或回复中断 | 尝试缩短对话或切换网络；流式也可能因上游长时间无数据而中断 |
| 思考正常但工具没执行 | 确认客户端提供工具且未禁用；若日志已有“工具调用”，检查客户端是否等待执行确认 |

## 更新

先停止服务，提交或备份自己修改的项目文件，再执行 `git pull` 并重新启动。升级后在客户端重新获取模型列表。

ZIP 用户请解压新版到新目录，使用桌面快捷方式时重新创建。默认凭据与项目目录分开，同一系统账户下通常可继续使用；自定义状态目录需继续使用原路径。版本检查只提示，不会自动更新文件。

## 高级配置

环境变量在启动前设置，修改后重启生效。例如将端口改为 8081，客户端地址也需改为 `http://127.0.0.1:8081/v1`。

```powershell
# PowerShell
$env:PROXY_PORT = "8081"
npm start
```

```sh
# macOS / Linux
PROXY_PORT=8081 npm start
```

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_PORT` | `8080` | 本地端口 |
| `PROXY_UPSTREAM` | 按网络选择 | 完整上游 Chat Completions URL，启动时优先于网络选择。对话和 Bearer token 会发送到此地址，仅配置可信服务 |
| `PROXY_BIND_HOST` | `127.0.0.1` | 监听 IP，也支持 `localhost`；非回环地址必须配置密钥，见 [局域网部署](docs/DEPLOY-LAN.md) |
| `PROXY_API_KEYS` | 未设置 | 逗号分隔的密钥，配置后开启 Bearer / `x-api-key` 鉴权；更改后重启生效 |
| `PROXY_TOOL_FIX` | `1` | `0` 关闭文本工具调用补救 |
| `PROXY_BODY_LIMIT_MB` | `64` | 请求体上限，单位 MiB，包含 JSON 与 Base64 图片 |
| `PROXY_NO_UPDATE_CHECK` | 未设置 | `1` 关闭启动时的 GitHub 版本检查 |
| `MADMODEL_STATE_DIR` | `~/.madmodel-proxy` | 凭据与状态目录 |

运行中输入 `campus` / `offcampus` 会覆盖当前进程的上游地址；下次启动仍以启动终端设置的 `PROXY_UPSTREAM` 为准。

<details>
<summary>超时、续期与排障参数</summary>

以下时间参数单位均为毫秒。长对话冷启动可能数分钟后才出首字；工具补救重发使用独立超时。实际等待还受客户端与上游连接限制。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PROXY_HEADER_MS` | `300000` | 发出上游请求到收到响应头的时限 |
| `PROXY_IDLE_MS` | `300000` | 收到响应头后等待上游数据的空闲时限，包含首帧等待 |
| `PROXY_STREAM_TOTAL_MS` | `1200000` | 收到上游响应头后的响应体总时限 |
| `PROXY_NONSTREAM_TOTAL_MS` | `600000` | 非流式聚合总超时，工具补救重发另计 |
| `PROXY_TOOL_RETRY_TIMEOUT_MS` | `300000` | 工具补救重发的整次请求时限 |
| `PROXY_RETRY_WAIT_MS` | `30000` | WebVPN 登录重定向后等待新凭据的时间 |
| `PROXY_REFRESH_AHEAD_MS` | `1800000` | 到期前多久开始续期 |
| `PROXY_NO_TOKEN_WAIT_MS` | `60000` | 无可用 token 且未配置凭据时的检查间隔 |
| `PROXY_MAX_SLEEP_MS` | `3600000` | 续期调度单次等待的上限 |
| `PROXY_KEEPALIVE_MS` | `1500000` | WebVPN 保活间隔，仅隧道模式启用 |
| `PROXY_DEBUG_BUDGET` | 未设置 | `1` 显示预算明细和输出上限调整；默认隐藏，不影响预算检查与实际 token 用量日志 |
| `DUMP_FAILED` | 未设置 | `1` 保存部分上游失败请求至状态目录的 `last-failed-request.json`，含完整对话，排障后请关闭并删除文件 |

`PROXY_TOKEN_FILE`、`MADMODEL_FORCE_TUNNEL_MODE` 和 `MADMODEL_KEYCHAIN_SERVICE` 用于开发与隔离测试。可用 `npm run watch` / `node proxy.js` 分别启动续期服务和代理。

</details>

<details>
<summary>模型列表、参数转换与兼容细节</summary>

- **模型列表**。候选来自上游前端 bundle 和本地配置，再用短对话请求逐个探测；上游 `/v1/models` 返回网页，不能用于获取 OpenAI 模型列表。探测有成功结果时，只返回这些模型；全部失败时，返回未被确认为不存在的候选。`available` 的 `true` / `false` / `null` 分别表示探测成功、失败和尚未探测。`target` 标记参考模型，`config.js` 的 `MODEL` 不参与请求路由。遗留名称 `DeepSeek-V4-Flash-0731` 请改为当前表中的 ID，代理不做前端的旧名映射。
- **思考参数**。原生 `chat_template_kwargs` 开关优先于顶层参数。未指定档位时使用能力列表的首档；无法关闭思考的模型仍可设置合法档位。Qwen 的 `reasoning` 转为 `reasoning_content`。
- **工具补救**。只解析完整的 DSML / Hermes 标记和客户端提供的工具名，拒绝代码围栏、反引号中的调用示例。响应为空或含有工具标记时才可能重发，单纯文字回答不触发重发。Qwen 按客户端的 `tool_choice` 请求原生调用，文本恢复仅作兜底；非流式补救遵守该接口的输出预算上限。完整合法调用若被上游标记为 `finish_reason: "stop"`，统一改为 `tool_calls`。
- **请求预算**。`max_completion_tokens` 转成 `max_tokens`；未明确关闭思考时，低于 512 的输出预算提升到 512。仅保留单个候选回复，删除 `logprobs` / `top_logprobs`。
- **token 计量**。本地用 DeepSeek 词表估算文本、历史思考和工具字段，另为 Qwen 预留本地输入估算的 20%。静态 PNG/JPEG/WebP 在支持范围内按公开模型处理器的尺寸规则计数，包含图片起止标记，每图另留 8 token 软余量；未知输入按每图 16,384 token 软估计。图片预算只辅助收缩输出，不用于本地拒绝请求，也不维护图片用量缓存。支持范围、EXIF 处理和实测结果见[预算说明](docs/TOKEN-BUDGET.md)。日志取上游实际用量，补救重试时合计已返回的数据。
- **速度日志**。成功请求结束时显示首字等待和均速。首字按代理收到首个思考、正文或工具调用计时；均速为上游输出 token（含思考）除以请求总耗时，包含等待和补救请求。无法测得首字时间或用量不完整时，省略对应指标。
- **流式与报错**。常规上游请求使用 SSE，非流式客户端由代理聚合。上游截断时不补发 `[DONE]`；开始发送 SSE 后出现错误，只能通过中断流和日志反映。
- **Qwen 缓存**。为 `qwen3.8-27b` 的每次上游请求生成新的 `cache_salt`，重试也更换，并覆盖客户端固定值。其他模型不受此措施影响。

</details>

## 更多

[更新记录](CHANGELOG.md) · [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE) · [第三方声明](THIRD-PARTY-NOTICES.md)

本项目为非官方客户端，学校服务或认证流程变化可能影响使用。
