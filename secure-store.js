// secure-store.js
// token 的 DPAPI 加密存取 + 原子写。token 等价于上游 API key,原明文落盘与
// 凭据文件里密码的 DPAPI 待遇不对等,统一加密。
// 兼容旧格式:读到 {token: "..."} 明文结构时照常返回并提示升级(下次续期自动转密)。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(process.env.USERPROFILE || '', '.dsh-madmodel');
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');

// 与 creds.js 相同的 DPAPI 调用形态:数据走 stdin,输出 base64,不进命令行。
// 写死系统 PowerShell 全路径:相对名受 PATH/CWD 解析顺序影响(注入面本身
// 干净——脚本是静态串,数据走 stdin;这是廉价加固)
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function dpapiInvoke(action, inputB64) {
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

function protectToken(plain) {
  return { v: 1, cipher: dpapiProtect(plain) };
}

function unprotectTokenRecord(record) {
  try {
    if (record && typeof record.token === 'string') return record.token; // 旧明文格式
    if (record && record.v === 1 && typeof record.cipher === 'string') {
      return dpapiUnprotect(record.cipher);
    }
  } catch (e) { /* DPAPI 解密失败(换账户/损坏):按无 token 处理 */ }
  return null;
}

function writeTokenRecord(token, expiresAt) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const record = { ...protectToken(token), expiresAt, updatedAt: new Date().toISOString() };
  // 原子写:先写临时文件再改名,读方不会拿到半截 JSON
  const tmp = TOKEN_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, TOKEN_FILE);
}

// 返回 { token, expiresAt } 或 null;坏记录返回 null 让调用方按"无 token"处理
function readTokenRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const token = unprotectTokenRecord(record);
    if (!token || !Number.isFinite(record.expiresAt)) return null;
    return { token, expiresAt: record.expiresAt };
  } catch (e) {
    return null;
  }
}

module.exports = { STATE_DIR, TOKEN_FILE, dpapiProtect, dpapiUnprotect, writeTokenRecord, readTokenRecord };

