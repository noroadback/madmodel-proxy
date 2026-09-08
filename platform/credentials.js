// platform/credentials.js
// 凭据与 token 存取的平台分发点。core/service 层只依赖这里的接口:
//   credentials.readToken() / writeToken(token, expiresAt)
//   credentials.readAccount() / writeAccount(user, pass, fingerprint) / hasAccount()
//
// 三平台实现:
//   win32   DPAPI(CurrentUser 范围,密文+元数据同文件)
//   darwin  登录钥匙串(security 命令行;秘密在钥匙串,元数据在 JSON)
//   linux   机器绑定 AES-256-GCM(machine-id+uid 派生密钥,同文件形态)
//
// 共同语义(调用方依赖):
//   - 读路径优雅降级:解不开/条目丢失按"无数据"返回 null,不抛——否则
//     watch 守护会在第一个 readToken 就崩,token 热加载也会被单次损坏拖垮
//   - 写路径原子:一律经 file-store 的 atomicWrite(0600),读者只见完整文件
//   - 旧明文 token 格式照常可读(手工恢复路径),下次续期自动转加密

'use strict';

const impl =
  process.platform === 'win32' ? require('./windows/credentials') :
  process.platform === 'darwin' ? require('./macos/credentials') :
  require('./linux/credentials');

module.exports = impl;
