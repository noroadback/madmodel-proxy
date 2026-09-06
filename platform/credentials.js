// platform/credentials.js
// 凭据与 token 存取的平台分发点。core/service 层只依赖这里的接口:
//   credentials.readToken() / writeToken(token, expiresAt)
//   credentials.readAccount() / writeAccount(user, pass, fingerprint) / hasAccount()
//
// 跨平台语义(与重写前的旧实现一致,CI 三平台测试依赖):
//   - **读路径优雅降级**:token 文件的旧明文格式照常可读;加密数据在无
//     DPAPI 的平台按"无数据"处理(返回 null),不抛错——否则非 Windows 上
//     watch 守护会在第一个 readToken 就崩,跨平台 CI 无法运行;
//   - **写路径明确拒绝**:非 Windows 调用 writeToken/writeAccount 抛
//     "依赖 Windows DPAPI",绝不落明文(不做不成熟的跨平台明文回退)。
//
// 两套行为都实现在 ./windows/credentials(读降级在其内部:加密解不开时
// 返回 null;写拒绝在其 dpapiInvoke 的平台检查),此处直接委托。

'use strict';

module.exports = require('./windows/credentials');
