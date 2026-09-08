// platform/windows/credentials.js
// Windows 密钥原语:DPAPI(CurrentUser 范围)加密,经系统 PowerShell 调用。
// 存储骨架(读写语义/文件形态)见 ../credential-store,本文件只提供原语。

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const createFileCredentialStore = require('../credential-store');

// 写死系统 PowerShell 全路径:相对名受 PATH/CWD 解析顺序影响。
// 数据走 stdin 而非命令行,不进进程列表与审计日志。
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 显式判平台:否则非 Windows 上抛的是裸 ENOENT powershell.exe,
// 用户看不出这是"凭据存储只支持 Windows"而非安装损坏
function dpapiInvoke(action, inputB64) {
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
  return Buffer.from(dpapiInvoke('unprotect', cipherB64), 'base64').toString('utf8');
}

module.exports = createFileCredentialStore({
  protect: dpapiProtect,
  unprotect: dpapiUnprotect,
  readFailureHint: '已换 Windows 账户或文件损坏',
});
