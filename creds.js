// creds.js
// 凭据存储:清华学号 + 密码 + 设备指纹。密码用 Windows DPAPI 加密
// (CurrentUser 范围),密文只对当前 Windows 账户可解。文件位于
// %USERPROFILE%\.dsh-madmodel\creds.json。

'use strict';

const fs = require('fs');
const path = require('path');
const { generateFingerprint } = require('./madmodel-auth');
const { dpapiProtect, dpapiUnprotect } = require('./secure-store');

const CREDS_DIR = path.join(process.env.USERPROFILE || '', '.dsh-madmodel');
// MADMODEL_CREDS_FILE:测试注入用,避免测试触碰真实凭据
const CREDS_FILE = process.env.MADMODEL_CREDS_FILE || path.join(CREDS_DIR, 'creds.json');

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
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  const record = {
    username,
    passwordCipher: dpapiProtect(password),
    fingerPrint: fingerPrint || generateFingerprint(),
    updatedAt: new Date().toISOString(),
  };
  // 原子写:先写同目录临时文件再改名,读方不会拿到半截 JSON
  const tmp = CREDS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.chmodSync(tmp, 0o600); // POSIX 语义;Windows 下基本为 no-op,无害
  fs.renameSync(tmp, CREDS_FILE);
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

