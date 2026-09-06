// platform/windows/credentials.js
// Windows 实现:账号凭据与 token 的 DPAPI 加密存取。
// token 等价于上游 API key,与凭据文件里的密码同等对待。
// 兼容旧格式:token 文件读到 {token: "..."} 明文结构时照常返回(下次续期自动转密)。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateFingerprint } = require('../../madmodel-auth');
const { atomicWrite } = require('../file-store');
const { TOKEN_FILE, CREDS_FILE } = require('../paths');

// 写死系统 PowerShell 全路径:相对名受 PATH/CWD 解析顺序影响。
// 数据走 stdin 而非命令行,不进进程列表与审计日志。
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function dpapiInvoke(action, inputB64) {
  // 显式判平台:否则非 Windows 上抛的是裸 ENOENT powershell.exe,
  // 用户看不出这是"凭据存储只支持 Windows"而非安装损坏
  if (process.platform !== 'win32') {
    throw new Error(`凭据与 token 的静态加密依赖 Windows DPAPI,当前平台 ${process.platform} 不支持`);
  }
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($in)',
    action === 'protect'
      ? '$out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)'
      : '$out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  return execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command', script], {
    windowsHide: true,
    input: inputB64,
  }).toString().trim();
}

function dpapiProtect(plain) {
  return dpapiInvoke('protect', Buffer.from(String(plain), 'utf8').toString('base64'));
}

function dpapiUnprotect(cipherB64) {
  const plainB64 = dpapiInvoke('unprotect', cipherB64);
  return Buffer.from(plainB64, 'base64').toString('utf8');
}

// ===== token 存取 =====
function unprotectTokenRecord(record) {
  try {
    if (record && typeof record.token === 'string') return record.token; // 旧明文格式
    if (record && record.v === 1 && typeof record.cipher === 'string') {
      return dpapiUnprotect(record.cipher);
    }
  } catch (e) { /* DPAPI 解密失败(换账户/损坏):按无 token 处理 */ }
  return null;
}

function writeToken(token, expiresAt) {
  const record = {
    v: 1,
    cipher: dpapiProtect(token),
    expiresAt,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(TOKEN_FILE, JSON.stringify(record, null, 2));
}

// 返回 { token, expiresAt } 或 null;坏记录返回 null 让调用方按"无 token"处理
function readToken() {
  try {
    const record = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const token = unprotectTokenRecord(record);
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

function writeAccount(username, password, fingerPrint) {
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

function hasAccount() {
  return fs.existsSync(CREDS_FILE);
}

module.exports = {
  dpapiProtect, dpapiUnprotect,
  readToken, writeToken,
  readAccount, writeAccount, hasAccount,
};
