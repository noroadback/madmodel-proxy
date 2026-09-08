// platform/credential-store.js
// 文件型凭据存储的共享骨架:密文+元数据同文件(creds.json / token.json),
// 加密原语(protect/unprotect)由平台实现注入。windows(DPAPI)与
// linux(机器绑定 AES-GCM)只差这一对原语;macOS 是钥匙串形态(秘密不在
// 文件里,见 platform/macos),不适用本骨架。
//
// 语义(调用方依赖):
//   - 读路径优雅降级:解不开(换机器/账户/损坏)按"无数据"返回 null,不抛
//     ——否则 watch 守护会在第一个 readToken 就崩
//   - 写路径原子:一律 atomicWrite(0600),读者只见完整文件
//   - 旧明文 token 格式({token:"..."})照常可读(手工恢复路径),
//     下次续期自动转加密

'use strict';

const fs = require('fs');
const { generateFingerprint } = require('../madmodel-auth');
const { atomicWrite } = require('./file-store');
const { TOKEN_FILE, CREDS_FILE } = require('./paths');

module.exports = function createFileCredentialStore({ protect, unprotect, readFailureHint }) {

  function tryUnprotect(cipher) {
    try { return unprotect(cipher) || null; } catch (e) { return null; }
  }

  // ===== token 存取 =====
  function writeToken(token, expiresAt) {
    atomicWrite(TOKEN_FILE, JSON.stringify({
      v: 1,
      cipher: protect(token),
      expiresAt,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  // 返回 { token, expiresAt } 或 null;坏记录返回 null 让调用方按"无 token"处理
  function readToken() {
    try {
      const record = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      let token = null;
      if (record && typeof record.token === 'string') token = record.token; // 旧明文格式
      else if (record && record.v === 1 && typeof record.cipher === 'string') token = tryUnprotect(record.cipher);
      if (!token || !Number.isFinite(record.expiresAt)) return null;
      return { token, expiresAt: record.expiresAt };
    } catch (e) {
      return null;
    }
  }

  // ===== 账号凭据存取(学号/密码/设备指纹) =====
  function readAccount() {
    if (!fs.existsSync(CREDS_FILE)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      if (!raw.username || !raw.passwordCipher || !raw.fingerPrint) return null;
      const password = tryUnprotect(raw.passwordCipher);
      if (!password) return null;
      return {
        username: raw.username,
        password,
        fingerPrint: raw.fingerPrint,
        updatedAt: raw.updatedAt,
      };
    } catch (e) {
      // 固定文案:e.message 可能携带密文片段,不该进日志
      console.error(`凭据读取失败(可能${readFailureHint}),可重新运行 login 配置`);
      return null;
    }
  }

  function writeAccount(username, password, fingerPrint) {
    const record = {
      username,
      passwordCipher: protect(password),
      fingerPrint: fingerPrint || generateFingerprint(),
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(CREDS_FILE, JSON.stringify(record, null, 2));
    // 密码只进内存与密文
    return {
      username: record.username,
      password,
      fingerPrint: record.fingerPrint,
    };
  }

  function hasAccount() {
    return fs.existsSync(CREDS_FILE);
  }

  return { readToken, writeToken, readAccount, writeAccount, hasAccount };
};
