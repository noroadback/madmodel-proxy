# madmodel-proxy

把清华 madmodel 服务变成一个**本机常驻的 OpenAI 兼容端点**。

madmodel（`madmodel.cs.tsinghua.edu.cn`，清华大学高性能计算中心部署的 DeepSeek 服务）只有网页形态、API token 约 5 小时过期，标准 OpenAI 客户端无法直接使用。本工具做三次"翻译"：

1. **形态翻译**：网页态服务 → 标准 OpenAI API（强制流式绕上游 60s 超时、非流式聚合、错误翻译、伪造 `/v1/models`）；
2. **时间翻译**：token 5 小时过期 → 无人值守自动续期（完整统一认证链自动化）；
3. **位置翻译**：校园网页服务 → 本机 `127.0.0.1` 端点（对话数据流经你可控的进程）。

## 特性

- **零 npm 依赖**:纯 Node 原生(`fetch`/`crypto`/`zlib`),clone 即用,无 `npm install`;第三方代码仅 vendored 的 sm-crypto(sm2.js,许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md))
- **token 自动续期**：到期前 30 分钟自动走完整登录链，代理按文件 mtime 热加载，免重启
- **完整统一认证自动化**：SM2 密码加密（强制 CSPRNG，不可用则拒绝加载）、二次认证（微信/短信/TOTP）、可信设备登记（登记后续期免二次认证）
- **静态数据加密**：密码与 token 均以 Windows DPAPI（CurrentUser）加密存储，密钥不出 Windows 账户
- **本地安全**：Bearer 鉴权（默认强制，自动生成 key）+ Host 白名单（防 DNS rebinding）+ 请求/响应多重限额与超时 + 客户端断连即中止上游
- **离线测试套件**：假上游 + 子进程，24 项端到端，不需要账号、不触网

## 测试状态

已在 Windows 11 + Node.js 24 + **dsh**（DeepSeek Harness）实测通过。代理对客户端只暴露标准 OpenAI 协议，其他 OpenAI 兼容客户端理论上同样可用，但**未逐一验证**——欢迎在 issue 中附上你的客户端与结果。

## 快速开始

前置条件：Windows 10/11 · Node.js ≥ 18.14 · 清华统一认证账号

```bat
node refresh-token.js login    :: 输入学号+密码(首次含二次认证,只需一次)
start.cmd                       :: 拉起续期守护 + 代理(双击即可)
node refresh-token.js key       :: 打印 API key(只生成一次,之后固定)
```

在 dsh（或其他 OpenAI 客户端）中配置：

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 上面 `key` 命令的输出 |
| 模型 | `DeepSeek-V4-Flash` |

详细步骤（含二次认证说明、故障排查表）：**[docs/connect-dsh.md](docs/connect-dsh.md)**

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_API_KEY` | 自动生成 | 显式指定本地鉴权 key（优先于 key 文件） |
| `PROXY_NO_AUTH` | 关 | `=1` 关闭本地鉴权（仅测试场景） |
| `PROXY_PORT` | `8080` | 监听端口 |
| `PROXY_NO_GZIP` | 关 | `=1` 关闭发往上游的请求体 gzip 编码 |
| `DUMP_FAILED` | 关 | `=1` 失败请求体落盘至 `%USERPROFILE%\.dsh-madmodel\`(含完整对话内容,隐私,默认关) |
| `PROXY_UPSTREAM` / `PROXY_TOKEN_FILE` | 真实值 | 测试注入用（指向本地假上游/假 token） |

## 架构

```
start.cmd
 ├─ refresh-token.js watch   token 续期守护(单实例锁,死 PID 自动接管)
 └─ proxy.js                 OpenAI 兼容代理(127.0.0.1,Host 白名单 + Bearer 鉴权)
       │
       └─ 唯一耦合点: ~/.dsh-madmodel/token.json
          (DPAPI 加密,临时文件+rename 原子写,读方按 mtime 缓存热加载)
```

**两个进程是有意拆分的**：

- **凭据隔离**——代理进程从不读取 creds.json、从不解密密码；处理网络输入的进程与最高敏感凭据分属不同进程边界；
- **爆炸半径**——续期链路（子进程、学校服务、网络重试）是全项目最脆弱的部分，与请求服务循环隔离，登录链崩溃不影响进行中的流式请求。

代价是需要锁文件与双窗口编排，详见源码注释。

## 安全设计

| 层 | 机制 |
|---|---|
| 网络 | 只监听 127.0.0.1，外部不可达 |
| 防跨域读取 | Host 头白名单（阻断 DNS rebinding） |
| 防盲写入 | Bearer key 强制鉴权（防恶意网页 CSRF 式盗用配额） |
| 防资源耗尽 | 连接数上限、请求头/请求体/慢速发送三段超时、Content-Length 预检、限速 60 req/min + 并发 8 |
| 防内存耗尽 | 上游响应体双路径上限（JSON 5MB / SSE 64MB） |
| 静态数据 | 密码与 token DPAPI 加密；DPAPI 调用数据走 stdin，不进命令行/审计日志 |
| 随机数 | SM2 熵池强制接 Node WebCrypto CSPRNG，不可用即拒绝启动 |
| 出站安全 | 登录链重定向仅跟随 `https://*.tsinghua.edu.cn`，被引向校外即中止 |

## 设计取舍与已知限制

- **仅限 Windows**：凭据/token 存储用 DPAPI（PowerShell 桥接）；
- **学校端点硬编码**：WebVPN 前缀、登录表单 URL、漫游 ID 等实测于 2026-09，学校改版即失效——失效时程序会给出明确错误信息，请提 issue；
- CookieJar / URL 解析为手写简化版（登录链是固定已验证路径，未实现 Domain/Expires 等标准语义）；
- 单模型（`DeepSeek-V4-Flash`）；限速参数按个人自用设计；
- watch 被强杀（任务管理器）后锁文件残留，下次启动自动探活接管（Windows 信号处理限制，见源码注释）。

## 已知兼容性问题:请求体压缩与上游 WAF 误报

上游 madmodel 前置的 WAF 存在**误报**:其 SQL 注入特征规则会拦截请求体明文中包含字面量 `"(set "` 的请求(该字面量常见于 agent 工具的系统提示词,如 dsh 的 `"(set wait: true)"` 工具语法)——对 JSON 对话体而言这是误判。

本代理默认对发往上游的请求体做 gzip 编码(`Content-Encoding: gzip`,标准 HTTP 特性,带宽上也是优化;`PROXY_NO_GZIP=1` 可关闭)。上游 WAF 对压缩后的请求体不再触发上述规则,上游服务本身正常处理压缩请求并返回结果。

关于安全中立性:gzip 编码**不改变任何权限边界**——请求仍携带使用者本人的 token,仍受上游鉴权与配额约束,改变仅在于 body 的传输编码形态;被触发的是一条对 JSON 对话体误判的注入特征规则。这属于灰色手段,作者不建议视为长期方案:受影响的用户应向学校信息化服务平台反馈该误报,推动根因修复。如上游修复误报或调整策略,直接设 `PROXY_NO_GZIP=1` 关闭即可。

## 合规声明

- 本工具**仅供清华大学师生在遵守学校相关规定的前提下个人使用**;使用者对自己的账号与配额负责。
- 本工具不提供、不代理任何配额共享;所有请求均使用使用者本人的统一认证凭据。
- 除"已知兼容性问题"一节披露的 WAF 误报规避(gzip 编码)外,本工具不绕过任何访问控制。
- 请勿将本工具用于共享账号、转售配额或任何服务他人的用途。

## 测试

```bat
npm test
```

`test-creds.js`（DPAPI 往返）+ `test-proxy.js`（24 项离线端到端：假上游 + 子进程代理，覆盖鉴权、Host 白名单、SSE 透传/聚合、错误翻译、超限、断连中止等；全程不触网、不需要账号）。

## 致谢

- [`sm2.js`](sm2.js):vendored [sm-crypto](https://github.com/JuneAndGreen/sm-crypto) v0.3.13(MIT,内含 jsbn 衍生代码),许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md);
- 统一认证登录协议:SM2 登录参考 MIT 许可的 [thu-learn-lib](https://github.com/robertying/thu-learn-lib)(Harry Chen);表单与可信设备协议知识参考 [learnX](https://github.com/robertying/learnX)(Rui Ying,MIT);二次认证流程参考 thu-info-app 的公开行为。以上均为**协议级参考**,本仓库代码为独立实现。

## 安全说明

数据处理边界(哪些数据去了哪、没去哪)与漏洞上报方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
