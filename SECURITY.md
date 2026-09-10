# 安全说明（SECURITY.md）

这个页面说清楚 madmodel-proxy 手里有哪些敏感数据、它们去了哪、没去哪。

## 数据流向

| 数据 | 静态存储 | 传输目的地 | 备注 |
|---|---|---|---|
| 统一认证密码 | 按平台静态加密（Windows DPAPI / macOS 登录钥匙串 / Linux 机器绑定加密），`creds.json` 或钥匙串，状态目录 `~/.madmodel-proxy/` | 仅以 SM2 加密报文发往 `id.tsinghua.edu.cn` | 不写日志、不进命令行、不经任何第三方 |
| madmodel token | 按平台静态加密，同上（`token.json` 或钥匙串） | 仅作为 Bearer 头发往 `madmodel.cs.tsinghua.edu.cn` | 同上 |
| 对话内容 | 不落盘（默认） | 经本代理发往 madmodel 上游 | `DUMP_FAILED=1` 时失败请求会落盘到状态目录，该文件含完整对话，排障后应删除 |
| 设备指纹 | 随凭据文件存储 | 发往学校登录服务用于可信设备登记 | 32 个十六进制字符（16 字节），每次安装重新生成 |

## 明确不会发生的事

- 密码和 token 不写日志、不进 PowerShell 命令行参数、不发往 `*.tsinghua.edu.cn` 之外的任何地址
- 登录链重定向只跟随 `https://*.tsinghua.edu.cn`，被引向校外地址立即中止
- 代理只监听 `127.0.0.1`，外部网络无法直连（本地无鉴权，边界就是本机回环加 Host 白名单）
- 浏览器恶意页面无法借本机端口盲发请求烧配额：跨源 POST 浏览器必带 Origin 头，非本机来源直接拒绝；非浏览器客户端（SDK、智能体）不发 Origin，不受影响
- 仓库目录不写入任何运行时数据，诊断和状态文件都在状态目录（Windows 为 `%USERPROFILE%\.madmodel-proxy\`，macOS / Linux 为 `~/.madmodel-proxy/`）
- Linux 的机器绑定加密：密钥由 `/etc/machine-id` 与当前用户派生，密文文件被拷贝或同步到其他机器后不可解（按无数据处理）；macOS 钥匙串同理，离开当前用户的钥匙串即不可读

## 漏洞报告

开 GitHub issue 描述问题就行，敏感漏洞可以在 issue 里留联系方式请求私下沟通。修复验证前请勿公开利用细节。
