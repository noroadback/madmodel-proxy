# 安全说明(SECURITY.md)

本页面说明 madmodel-proxy 处理哪些敏感数据、它们去了哪、没去哪。

## 数据流向

| 数据 | 静态存储 | 传输目的地 | 备注 |
|---|---|---|---|
| 统一认证密码 | DPAPI 加密,`%USERPROFILE%\.dsh-madmodel\creds.json` | 仅以 SM2 加密报文发往 `id.tsinghua.edu.cn` | 不写日志、不进命令行、不经任何第三方 |
| madmodel token | DPAPI 加密,`token.json` | 仅作为 Bearer 头发往 `madmodel.cs.tsinghua.edu.cn` | 同上 |
| 本地 API key | 明文,`api-key`(用户目录默认 ACL 保护) | 不出本机 | 用于代理鉴权;`node refresh-token.js key` 可查看 |
| 对话内容 | 不落盘(默认) | 经本代理发往 madmodel 上游 | `DUMP_FAILED=1` 时失败请求会落盘到状态目录,注意该文件含完整对话 |
| 设备指纹 | 随凭据文件存储 | 发往学校登录服务用于可信设备登记 | 32 位随机 hex,每次安装重新生成 |

## 明确不会发生的事

- 密码/token/API key 不写日志、不进 PowerShell 命令行参数、不发送到 `*.tsinghua.edu.cn` 之外的任何地址;
- 登录链重定向仅跟随 `https://*.tsinghua.edu.cn`,被引向校外地址立即中止;
- 代理只监听 `127.0.0.1`,外部网络无法直连;
- 本仓库目录不写入任何运行时数据(诊断/状态文件均在 `%USERPROFILE%\.dsh-madmodel\`)。

## 漏洞报告

请开 GitHub issue 描述问题;敏感漏洞可在 issue 中留联系方式请求私下沟通。修复验证前请勿公开利用细节。
