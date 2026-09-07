# madmodel-proxy

把清华 madmodel 变成本机一个配好就不用管的 OpenAI 端点。login 一次、双击 start.cmd，之后 token 的获取、续期、轮转全归它管，你的客户端只认 `http://127.0.0.1:8080/v1`。

> **项目定位（先读这个再决定是否使用）**
> - **Windows 专用**。凭据与 token 的静态加密依赖 Windows DPAPI，完整功能仅在 Windows 10/11 上可用；
> - **清华 madmodel 服务专用**。登录链、上游端点、SSE 帧型均实测于 `madmodel.cs.tsinghua.edu.cn` 及清华统一认证（2026-09）；
> - **本地代理**。监听 `127.0.0.1:8080`，面向本机 OpenAI 兼容客户端，不是服务端部署方案；
> - **不保证适用于其他认证系统或其他上游服务**。学校端点改版即失效，失效时会给出明确错误，欢迎提 issue。

madmodel（`madmodel.cs.tsinghua.edu.cn`，清华大学高性能计算中心部署的 DeepSeek 服务）本身提供 OpenAI 格式的 API，官方文档里就有 `openai` 库的直连示例。直接把客户端指过去，"你好"级别的短请求能通，真实用起来会撞上两件事。

第一件是 token。API key 只有 5 小时有效期，官方的获取方式是登录网页后手动复制，过期再登录一次。对每天重度使用的 agent 工作流来说，这是每天数次的打断。

第二件是行为。上游的接口是 OpenAI 形态，行为却和客户端预期对不上（2026-09-06 直连实测，逐条复现，见"已验证的上游行为"）。非流式请求在 60 秒整被网关掐断；WAF 会误拦含工具语法的明文请求体；一切错误都包在 `HTTP 200` 里返回"服务器繁忙"；`GET /v1/models` 返回的是网页 HTML；`logprobs` 一类参数直接被拒；流可能中途截断而没有 `[DONE]`。

这个项目把两件事都接走。续期守护用 DPAPI 存储的凭据自动走完整统一认证链（可信设备登记后续期免二次认证），到期前 30 分钟换新 token，代理热加载，客户端全程无感。行为差异在代理层逐项适配，对上游恒以流式请求、客户端要非流式就由代理聚合，请求体默认 gzip 编码，错误翻译回真实的 4xx/5xx，伪造 `/v1/models`，剥离上游拒绝的参数，流截断按错误处理、不把半截回答当成功。最后封装成本机 `127.0.0.1:8080` 的常驻端点，加一层本地 Bearer 鉴权，学校 token 不进任何客户端配置，对话数据流经你可控的进程。

## 特性

- **零 npm 依赖**。纯 Node 原生（`fetch`/`crypto`/`zlib`），clone 即用，无需 `npm install`。第三方代码只有 vendored 的 sm-crypto（sm2.js），许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- **token 自动续期**。到期前 30 分钟自动走完整登录链，代理按文件 mtime 热加载，免重启。
- **完整统一认证自动化**。SM2 密码加密（强制 CSPRNG，不可用即拒绝加载）、二次认证（微信/短信/TOTP）、可信设备登记（登记后续期免二次认证）。
- **静态数据加密**。密码与 token 均以 Windows DPAPI（CurrentUser）加密存储，密钥不出 Windows 账户。
- **本地安全**。Bearer 鉴权（默认强制，自动生成 key）、Host 白名单（防 DNS rebinding）、请求与响应的多重限额和超时，客户端断连即中止上游。
- **单窗口运行**。start.cmd 经 dashboard.js 同窗拉起守护与代理，`[代理]`/`[watch]` 前缀区分日志，Ctrl+C 或关窗全停。
- **真实 usage**。对上游注入 `include_usage`（上游默认不回 usage），非流式聚合与流式透传都带真实 token 数，`reasoning_tokens` 单独可见。
- **参数归一化**。模型名重写、剥离上游拒绝的参数（`logprobs` 等）、把三种"关闭推理"方言统一映射到上游唯一生效的写法，客户端不必为这个端点特调。
- **离线测试套件**。假上游加子进程，177 项端到端与单元测试，不需要账号、不触网。

## 测试状态

已在 Windows 11 + Node.js 24 + **dsh**（DeepSeek Harness）实测通过。

**能接入哪些客户端**。任何支持"自定义 OpenAI Base URL"的智能体或客户端都能接入，指向 `http://127.0.0.1:8080/v1`、用本地 key 鉴权即可，协议层就是标准 OpenAI 形态（chat completions + models）。边界也要说清。只有 chat completions 一个业务端点，没有 embeddings、图像、音频；单模型，任意模型名都会被重写为 `DeepSeek-V4-Flash`（见"设计取舍"）；`logprobs`/`n>1` 会被剥离（上游拒绝）；代理宿主机必须是 Windows，客户端本身不限平台。dsh 之外（codex、claude code 等）未逐一验证，欢迎在 issue 里附上你的客户端与结果。

## 运行前提与平台支持

- **完整功能（代理 + 续期守护）当前只支持 Windows 10/11**。凭据与 token 的静态加密依赖 Windows DPAPI（`platform/windows/`），本项目不做跨平台明文回退。
- **Linux/macOS 不属于正式支持平台**。只能运行不依赖 DPAPI 的纯逻辑离线测试（`npm test` 中 DPAPI 相关部分自识别跳过），不能跑代理与续期。
- **Node.js >= 18.14**。
- **清华统一认证账号**（且你遵守学校对该服务与配额的相关规定）。

## 快速开始

```bat
rem 1. 首次配置:输入学号+密码(首次含二次认证,只需一次)
node refresh-token.js login
rem 2. 启动:单窗口拉起续期守护 + 代理(双击 start.cmd 亦可)
start.cmd
rem 3. 随时查看运行状态:代理/token/watch/key 一屏汇总(双击 status.cmd 亦可)
node refresh-token.js status
rem 4. 打印 API key(配置客户端用,只生成一次,之后固定)
node refresh-token.js key
```

最容易卡住的一步是首次 login 的二次认证，输错验证码重试即可，登记可信设备之后续期不再需要它。详细步骤见 [docs/connect-dsh.md](docs/connect-dsh.md)。

在 dsh（或其他 OpenAI 客户端）里这样配置。

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 上面 `key` 命令的输出 |
| 模型 | `DeepSeek-V4-Flash` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_API_KEY` | 自动生成 | 显式指定本地鉴权 key（优先于 key 文件） |
| `PROXY_NO_AUTH` | 关 | `=1` 关闭本地鉴权（仅测试场景） |
| `PROXY_PORT` | `8080` | 监听端口 |
| `PROXY_NO_GZIP` | 关 | `=1` 关闭发往上游的请求体 gzip 编码 |
| `PROXY_REFRESH_AHEAD_MS` | 1800000 | 提前续期窗口，正整数毫秒 |
| `PROXY_NO_TOKEN_WAIT_MS` | 60000 | 无凭据时的兜底检查间隔，正整数毫秒 |
| `PROXY_MAX_SLEEP_MS` | 3600000 | 检查时钟或补偿丢失文件事件的最长等待，正整数毫秒 |
| `PROXY_STREAM_TOTAL_MS` | 1200000 | 单次流式请求总时限（毫秒），一般无需修改 |
| `DUMP_FAILED` | 关 | `=1` 时被上游拒绝（可解析的上游错误）的请求体落盘至 `%USERPROFILE%\.dsh-madmodel\`，含完整对话内容，注意隐私；网络错误、超时、流截断不落盘 |
| `PROXY_UPSTREAM` / `PROXY_TOKEN_FILE` | 真实值 | 测试注入用（指向本地假上游/假 token） |

## 安全提示（配置前必读）

- **`api-key` 文件是明文保存**（位于 `%USERPROFILE%\.dsh-madmodel\api-key`）。它需要人工抄进客户端配置、离开本机即无用，这是有意取舍。文件受用户目录 ACL 保护，但请勿把它提交到任何仓库或截图外发。
- **不要设置 `PROXY_NO_AUTH=1` 后监听非本机地址**。`PROXY_NO_AUTH` 本为离线测试而设，关闭鉴权后任何能触达该端口的进程都可匿名消耗你的配额。代理硬编码只监听 `127.0.0.1`，请保持这一边界。
- **`DUMP_FAILED=1` 会保存完整请求体**到 `%USERPROFILE%\.dsh-madmodel\last-failed-request.json`，其中包含完整对话内容，属于隐私数据。排障后请及时删除，更不要提交或外发该文件。

更多数据流向（什么数据去了哪、没去哪）见 [SECURITY.md](SECURITY.md)。

## 常见故障排查

| 现象 | 原因与处理 |
|---|---|
| 请求 401 `token 已过期` | watch 续期守护未运行或续期失败。先 `node refresh-token.js status` 查看 watch 与 token 状态；watch 未运行就用 `start.cmd` 启动；续期失败按日志里的错误码处理（见下） |
| 请求 401 `无效或缺失 API key` | 客户端 Bearer key 与代理不一致。`node refresh-token.js key` 重新查看，粘贴进客户端配置；注意 `PROXY_API_KEY` 环境变量优先于 key 文件 |
| 启动报 `端口 8080 已被占用` | 代理已在运行（start.cmd 重复启动），或端口被其他程序占用。确认是旧实例后直接复用；确需另开实例用 `PROXY_PORT` 换端口 |
| 上游 401（认证失败） | token 失效但代理尚未感知。等 watch 续期完成（日志出现"token 已热加载"），或手动 `node refresh-token.js once` |
| 上游 429（限流/繁忙） | 上游服务繁忙、上下文逼近 256K、或请求体超限。压缩上下文后重试；若客户端并发/重试过猛，靠客户端自身的退避收敛（代理业务层不限并发） |
| 上游 502（网关/断流） | 校方网关瞬时不可达（实测 TsinghuaLB 502），通常自愈。持续出现请检查网络与学校服务状态，并提 issue 附日志 |
| token 长期无人续期 | `TWO_FACTOR_REQUIRED`（可信设备登记失效）需手动跑一次 `login`；`BAD_CREDENTIALS` 连续三次会停守护，改密码后需重新 `login` |

`status.cmd`（或 `node refresh-token.js status`）是以上所有排查的第一入口，代理/token/watch/key 一屏汇总。

## 自动续期

守护进程按 token 的到期时间计算续期窗口，默认在剩余 30 分钟时刷新。等待期间监听 token 和凭据所在目录，文件创建、删除或原子替换会立即唤醒，重新读取状态并计算下一次等待时间。临时文件和锁文件的变化不会触发唤醒。

认证失败后按 1、5、15、30 分钟退避。文件事件可以提前触发状态检查，但不会绕过认证重试的截止时间。成功续期后重新计算窗口；新 token 有效期过短时，至少间隔 1 分钟再尝试。目录监听不可用时保留定时检查。

更新代码后需重启现有 watch 进程才能使用新调度逻辑。

## 架构

```
start.cmd → dashboard.js(单窗口:前缀交错显示,Ctrl+C/关窗全停)
 ├─ refresh-token.js watch   token 续期守护(单实例锁,死 PID 自动接管)
 │     └─ adapters/cli.js 命令分发 → auth-service.js 认证业务
 │           └─ core/scheduler.js 续期状态机(WAITING/REFRESHING/BACKOFF/STOPPED)
 └─ proxy.js                 启动入口:组装 config + core + adapters 并监听
       └─ adapters/http-server.js   HTTP 适配:路由/Host+Bearer 鉴权/请求体读取/
       │                          响应写出/token 热加载缓存
             └─ core/proxy-service.js  业务流程:认证→归一化→上游→映射→响应
                   ├─ core/upstream-client.js     上游调用(单 AbortController,
                   │                              header/idle/total 统一超时清理)
                   ├─ core/stream-parser.js        SSE 协议解析(含 UTF-8 解码)
                   ├─ core/completion-aggregator.js 非流式聚合
                   ├─ core/payload.js              请求解析与参数归一化
                   └─ core/errors.js               错误映射(上游错误/结果→状态码)
       │
       └─ 唯一耦合点: ~/.dsh-madmodel/token.json
          (DPAPI 加密,临时文件+rename 原子写,读方按 mtime 缓存热加载)

分层规则:core/ 不读环境变量、不碰文件系统、不依赖 Windows API、不写 HTTP
响应;platform/ 收拢 DPAPI 凭据、路径、原子文件、进程锁与目录监听;
adapters/ 只做 HTTP 与终端 I/O。

platform/:
  paths.js          状态文件路径 + 本地鉴权 key 优先级(唯一来源)
  file-store.js     原子写/独占安装/争用仲裁 + 文件事件唤醒
  credentials.js    凭据与 token 存取接口 → windows/credentials.js(DPAPI)
  process-lock.js   进程锁接口 → windows/process-lock.js(PID 探活)
```

代理与续期守护拆成两个进程是有意的。

- **凭据隔离**。代理进程从不读取 creds.json、从不解密密码，处理网络输入的进程与最高敏感凭据分属不同进程边界。
- **爆炸半径**。续期链路（子进程、学校服务、网络重试）是全项目最脆弱的部分，与请求服务循环隔离，登录链崩溃不影响进行中的流式请求。

代价是需要锁文件与进程编排，详见源码注释。dashboard.js 是纯编排器，两个子进程仍是完全独立的进程，上述拆分理由全部成立；调试时可绕过它分别运行 `node refresh-token.js watch` 与 `node proxy.js`，行为与从前一致。

## 安全设计

| 层 | 机制 |
|---|---|
| 网络 | 只监听 127.0.0.1，外部不可达 |
| 防跨域读取 | Host 头白名单（阻断 DNS rebinding） |
| 防盲写入 | Bearer key 强制鉴权（防恶意网页 CSRF 式盗用配额） |
| 防资源耗尽 | 连接数上限（32）、inflight 进程保护硬上限（64，不可配置）、请求头/请求体/慢速发送三段超时、Content-Length 预检（业务层无限流，见"设计取舍"） |
| 防内存耗尽 | 上游响应体双路径上限（JSON 5MB / SSE 64MB） |
| 静态数据 | 密码与 token DPAPI 加密；DPAPI 调用数据走 stdin，不进命令行/审计日志 |
| 随机数 | SM2 熵池强制接 Node WebCrypto CSPRNG，不可用即拒绝启动 |
| 出站安全 | 登录链重定向仅跟随 `https://*.tsinghua.edu.cn`，被引向校外即中止 |

**威胁画像**。本代理只监听 127.0.0.1，能触达它的只有本机进程和浏览器页面。日常使用中真正高频的对手，是不可靠的上游（网关断流、连接悬挂）和失控的客户端（agent 重试风暴、超大请求体）。上表"防资源耗尽/防内存耗尽"两层主要服务于后者；面向攻击者的层（鉴权、Host 白名单）针对的是恶意网页盲调这类低频但真实的场景。防御触发会留痕，含 401/403/413/429 在内的早退请求同样进访问日志，事后可查"有没有进程在打我、限速挡掉了多少"。

**DPAPI 的覆盖面**。CurrentUser 范围的 DPAPI 防的是文件离开本机或当前 Windows 账户（磁盘被离线挂载、U 盘拷贝、网盘同步快照）。它防不了以当前用户身份运行的代码，后者一次系统调用就能解密，用户态无解，对这类威胁本项目的控制是架构层的进程隔离，代理进程从不读取 creds.json。`api-key` 文件是明文，这是有意的取舍。它需要人工抄进客户端配置，离开本机就没用，且受用户目录 ACL 保护。

## 设计取舍与已知限制

- **仅限 Windows**。凭据/token 存储用 DPAPI（PowerShell 桥接）。
- **学校端点硬编码**。WebVPN 前缀、登录表单 URL、漫游 ID 等实测于 2026-09，学校改版即失效。失效时程序会给出明确错误信息，请提 issue。
- **CookieJar / URL 解析为手写简化版**。登录链是固定已验证路径，未实现 Domain/Expires 等标准语义。
- **单模型**（`DeepSeek-V4-Flash`）。
- **业务层无限流，只保留进程保护**（2026-09-06 调整）。多子代理编排是合法负载，原来的并发 8 会常态化误伤，所以移除了业务层限流，留下一个固定的 inflight 硬上限（64，代码常量，刻意不可配置）。这个上限只代表本地进程保护，防失控客户端拖垮内存和连接，与上游并发能力无关（上游真实容量未测）。超限时返回 429，本地过载与上游 429 可以区分。本地过载的响应文案是"代理过载保护（进程保护）"、`type` 为 `rate_limit`、日志 note 为 `overload:inflight=N`；上游 429 经翻译携带上游原文、日志 note 为 `upstream-err`。`server.maxConnections=32` 与各级超时、字节上限继续兜底。有界探测（24 并发突发）未见上游限流，但长期持续负载下的上游行为未验证，重度使用时留意 `overload:` 日志。
- **watch 被强杀后锁文件残留**（任务管理器）。下次启动自动探活接管（Windows 信号处理限制，见源码注释）。

## Roadmap（欢迎贡献）

1. **测试迁移到 `node:test`**。当前部分断言为顺序脚本，迁移后获得用例隔离、失败即停与 TAP 输出（零依赖不变，Node 原生）。
2. **跨平台（Windows 优先的取舍）**。secrets 三平台后端，参考 learnX/thu-info-app 的钥匙串实践。
3. **更多客户端实测**。codex / claude code 等，补 `docs/connect-*.md`。

已完成的工作（core/platform/adapters 分层重写、原子文件原语收敛到 `platform/file-store.js`、路径与鉴权优先级统一在 `platform/paths.js`、流式/非流式结果分派合并、请求参数归一化、认证链离线测试）见 [CHANGELOG.md](CHANGELOG.md)。

## 已知兼容性问题（请求体压缩与上游 WAF 误报）

上游 madmodel 前置的 WAF 有**误报**。它的 SQL 注入特征规则会拦截请求体明文里含字面量 `"(set "` 的请求，这个字面量常见于 agent 工具的系统提示词，比如 dsh 的 `"(set wait: true)"` 工具语法，对 JSON 对话体而言是彻底的误判。2026-09-06 直连实测复现了它，同一请求体明文发送收到 404 HTML 拦截页，gzip 编码发送就正常通过。拦截发生在鉴权之前，与 token 无关。

本代理默认对发往上游的请求体做 gzip 编码（`Content-Encoding: gzip`，标准 HTTP 特性，带宽上也是优化；`PROXY_NO_GZIP=1` 可关闭）。压缩后的请求体不再触发该规则，上游服务本身正常处理。

安全上这件事是中立的。gzip 只改变 body 的传输编码形态，请求仍携带使用者本人的 token，仍受上游鉴权与配额约束，被触发的是一条对 JSON 对话体误判的注入特征规则。作者不建议把它当长期方案，受影响的用户应向学校信息化服务平台反馈误报，推动根因修复。上游修好误报后，设 `PROXY_NO_GZIP=1` 关闭即可。

## 已验证的上游行为（2026-09 实测）

- **`logprobs` 参数会被网关拒绝**，且表现为流内"服务器繁忙"。代理默认剥离该参数，需要概率输出的评测工具在此端点仍然不可用。
- **一切错误包装在 `HTTP 200` 里**（2026-09-06 直连实测）。非流式形态是 `200 + {"status":10001/10003,"message":"服务器繁忙/您无此权限"}`，包括认证失败、模型不存在、参数被拒这些本该是 401/404/400 的情形；流式形态是 SSE 内嵌 `{"errorMessage":"..."}`。直连客户端会把它们当成上游过载去盲目重试，或当成成功空响应。代理翻译为真实的 4xx/5xx 与原因。
- **非流式请求在 60 秒整被网关掐断**（2026-09-06 直连实测，4000 字生成的非流式请求在 60011ms 处收到 504 Gateway Time-out HTML）。代理对上游恒以流式请求，实测可稳定运行 10 分钟；客户端要非流式时代理自行聚合，这是长生成唯一可靠的取回方式。
- **模型清单已变更**。官方旧文档示例的 `DeepSeek-R1-671B`/`R1-32B` 已不可用（2026-09-06 直连实测返回 10001），当前唯一可用模型为 `DeepSeek-V4-Flash`，与代理的单模型设计一致。
- **负载均衡器会直接返回 HTML 502 错误页**（TsinghuaLB，后端瞬时不可达时出现）。代理识别并翻译为明确文案，客户端重试通常自愈。
- **`usage` 仅在请求携带 `stream_options.include_usage` 时返回**（含 `reasoning_tokens` 单独计数）。代理默认注入，客户端拿到的即真实用量。
- **模型名精确匹配 `DeepSeek-V4-Flash`**，缺失或拼错返回"模型不存在"。代理会把任意模型名重写为它。
- **流中会夹带空数据帧**（`data:` 空行，网关心跳；2026-09-05 实测，曾致坏帧误判）。代理容忍空帧，非空坏帧仍按协议错误终止。
- **突发速率无本地限制**（2026-09-06 有界探测，64 个微型请求、4→24 并发递增、约 25 秒全部 200，上游未触发任何限流）。该探测只覆盖短时突发，持续负载、长流、大响应体下的上游行为未测，不构成"上游无限制"的证据。
- **思考控制**。官方 API 方言（`thinking`/`reasoning_effort`）无效，仅 vLLM 方言 `chat_template_kwargs: {"thinking": false}` 能关闭推理（上游默认全开）。代理会把前两种方言的"关闭"意图映射到后者。

## 合规声明

- 本工具**仅供清华大学师生在遵守学校相关规定的前提下个人使用**，使用者对自己的账号与配额负责。
- 本工具不提供、不代理任何配额共享，所有请求均使用使用者本人的统一认证凭据。
- 本工具**不绕过任何鉴权与配额类访问控制**。唯一例外是"已知兼容性问题"一节披露的 WAF 内容检查误报规避（gzip 编码，针对误报的临时手段，`PROXY_NO_GZIP=1` 可关闭）。
- 请勿将本工具用于共享账号、转售配额或任何服务他人的用途。

## 测试

```bat
npm test
```

- **全程离线**。不需要账号、不访问真实校方服务、不消耗配额，任何网络环境可跑，失败以非零退出码结束。
- **`npm run smoke` 不属于离线测试**。它是真实流量冒烟（`smoke-real.js`），需要代理在线、真实校方服务和有效 token，并消耗少量配额。离线套件只能覆盖已知的上游帧型，空心跳帧这类行为只有真实流量能暴露（2026-09-05 曾因此事故）。凡是改动 SSE 解析、错误处理、超时等协议行为，改完先跑冒烟再算完成。

共 177 项断言，分三层（全部离线；另有 `test-creds.js` 的 3 项 DPAPI 自检不计入分项）。

- `test-auth.js`（38 项）。认证链纯逻辑，包括响应体 charset 解码与嗅探回退、重定向白名单（含 userinfo 伪装绕过尝试）、CookieJar 路径匹配与合并 Set-Cookie 切分、JWT 过期兜底、WebVPN URL 改写。
- `node --test` 单元测试（70 项）。`test-config.js`、`test-sse.js`、`test-payload.js`、`test-aggregator.js`、`test-errors.js`、`test-upstream.js`、`test-scheduler.js`（10 项，调度状态机）、`test-inflight.js`（8 项，进程保护硬上限与异常路径释放）、`test-wakeup.js`，覆盖 core 与 platform 各模块的接口契约。本地假上游，不起真实连接；调度器与 inflight 守卫用注入依赖离线驱动。
- `test-proxy.js`（69 项）。假上游加子进程的代理端到端，覆盖鉴权、Host 白名单、SSE 透传与聚合、错误翻译、SSE 内嵌错误与 HTML 错误页翻译、流截断不伪装成功、坏帧不静默跳过、空数据帧容忍、大块合法行不误触上限、`[DONE]` 后挂起不泄漏连接、周期心跳与慢速 JSON 的总时限、超限、断连中止、并发透传（16 并发全部 200）、早退日志留痕、usage 注入、参数归一化、干净目录 bootstrap、坏锁与空锁恢复、key 命令与环境变量一致性。

## 贡献

参与开发（环境要求、测试写法、PR 流程）见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为规范见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。发布前本地自检（文件齐全、敏感文件未入库、Node 版本匹配）可跑 `npm run check:release`。

## 致谢

- [`sm2.js`](sm2.js)。vendored [sm-crypto](https://github.com/JuneAndGreen/sm-crypto) v0.3.13（MIT，内含 jsbn 衍生代码），许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；与上游 `dist/sm2.js` 逐字节相同，核验命令 `tail -c 36233 sm2.js | sha256sum`，期望值记于文件头部。
- 统一认证登录协议。SM2 登录参考 MIT 许可的 [thu-learn-lib](https://github.com/robertying/thu-learn-lib)（Harry Chen）；表单与可信设备协议知识参考 [learnX](https://github.com/robertying/learnX)（Rui Ying，MIT）；二次认证流程参考 thu-info-app 的公开行为。以上均为协议级参考，本仓库代码为独立实现。thu-info-app 的协议库 [@thu-info/lib](https://www.npmjs.com/package/@thu-info/lib) 为 BSL 1.1 许可，与 MIT 不兼容，本项目未引用其任何代码。

## 安全说明

数据处理边界（哪些数据去了哪、没去哪）与漏洞上报方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)

## 变更日志

[CHANGELOG.md](CHANGELOG.md)
