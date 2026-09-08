# 安全说明（SECURITY.md）

这个页面说清楚 madmodel-proxy 手里有哪些敏感数据、它们去了哪、没去哪。

## 数据流向

| 数据 | 静态存储 | 传输目的地 | 备注 |
|---|---|---|---|
| 统一认证密码 | DPAPI 加密，`%USERPROFILE%\.dsh-madmodel\creds.json` | 仅以 SM2 加密报文发往 `id.tsinghua.edu.cn` | 不写日志、不进命令行、不经任何第三方 |
| madmodel token | DPAPI 加密，`token.json` | 仅作为 Bearer 头发往 `madmodel.cs.tsinghua.edu.cn` | 同上 |
| 对话内容 | 不落盘（默认） | 经本代理发往 madmodel 上游 | `DUMP_FAILED=1` 时失败请求会落盘到状态目录，该文件含完整对话，排障后应删除 |
| 设备指纹 | 随凭据文件存储 | 发往学校登录服务用于可信设备登记 | 32 个十六进制字符（16 字节），每次安装重新生成 |

## 明确不会发生的事

- 密码和 token 不写日志、不进 PowerShell 命令行参数、不发往 `*.tsinghua.edu.cn` 之外的任何地址
- 登录链重定向只跟随 `https://*.tsinghua.edu.cn`，被引向校外地址立即中止
- 代理只监听 `127.0.0.1`，外部网络无法直连（本地无鉴权，边界就是本机回环加 Host 白名单）
- 仓库目录不写入任何运行时数据，诊断和状态文件都在 `%USERPROFILE%\.dsh-madmodel\`

## 漏洞报告

开 GitHub issue 描述问题就行，敏感漏洞可以在 issue 里留联系方式请求私下沟通。修复验证前请勿公开利用细节。
