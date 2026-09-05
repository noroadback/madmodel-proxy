// creds.js
// 凭据存储:清华学号 + 密码 + 设备指纹。密码用 Windows DPAPI 加密
// (CurrentUser 范围),密文只对当前 Windows 账户可解。

'use strict';

const fs = require('fs');
const { generateFingerprint } = require('./madmodel-auth');
const { dpapiProtect, dpapiUnprotect } = require('./secure-store');
const { atomicWrite } = require('./atomic-file');
const { CREDS_FILE } = require('./paths');

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (!raw.username || !raw.passwordCipher || !raw.fingerPrint) return null;
    return {
      username: raw.username,
      password: dpapiUnprotect(raw.passwordCipher),
      fingerPrint: raw.fingerPrint,
      updatedAt: raw.updatedAt,
    };
  } catch (e) {
    // 固定文案:e.message 可能携带密文片段或 PowerShell 脚本内容,不该进日志
    console.error('凭据读取失败(可能已换 Windows 账户或文件损坏),可重新运行 login 配置');
    return null;
  }
}

function saveCreds(username, password, fingerPrint) {
  const record = {
    username,
    passwordCipher: dpapiProtect(password),
    fingerPrint: fingerPrint || generateFingerprint(),
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(CREDS_FILE, JSON.stringify(record, null, 2));
  // 密码只进内存与 DPAPI 密文
  return {
    username: record.username,
    password,
    fingerPrint: record.fingerPrint,
  };
}

function hasCreds() {
  return fs.existsSync(CREDS_FILE);
}

module.exports = { loadCreds, saveCreds, hasCreds, CREDS_FILE };
