// platform/linux/credentials.js
// Linux 实现:机器绑定加密。密钥由 /etc/machine-id + 当前 uid/用户名 经
// scrypt 派生,AES-256-GCM 加密,盐/IV/认证标签连同密文存进 creds.json /
// token.json(与 Windows 同形态)。文件权限由 atomicWrite 固定 0600。
//
// 保护口径:文件被同步/拷贝到其他机器或账户后解不开(按无数据处理,重新
// login 即可)——堵住 ~ 下点文件被云同步、误提交进 git 的现实威胁。本机
// 同用户进程可解:这层威胁 DPAPI 同样挡不住(任何本地凭据方案的下界)。
//
// 为什么不用 secret-tool(D-Bus Secret Service):无人值守守护在无桌面会话/
// SSH 下读不了锁着的 keyring,那是最脆的依赖;机器绑定方案无守护、无提示、
// 无交互,是常驻进程的正确形态。
//
// 纪律与 Windows 侧一致:读路径优雅降级(解不开按"无数据"返回 null,不抛),
// 写路径原子(atomicWrite),每次写入换新盐防离线比对。

'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { generateFingerprint } = require('../../madmodel-auth');
const { atomicWrite } = require('../file-store');
const { TOKEN_FILE, CREDS_FILE } = require('../paths');

// machine-id 是 systemd 发行版的机器唯一标识,两个标准位置都看。
// 读不到时 fail closed(部分容器为空文件):宁可不跑,不静默降级为弱绑定
function machineKeyMaterial() {
  let machineId = '';
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machineId = fs.readFileSync(p, 'utf8').trim();
      if (machineId) break;
    } catch (e) { /* 试下一处 */ }
  }
  if (!machineId) {
    throw new Error('无法读取 machine-id(/etc/machine-id),机器绑定加密不可用');
  }
  const user = os.userInfo();
  return `${machineId}:${user.uid}:${user.username}`;
}

function seal(plain) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(machineKeyMaterial(), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  // base64 不含 '.',四段安全拼接
  return [salt, iv, cipher.getAuthTag(), ct]
    .map(b => b.toString('base64')).join('.');
}

// 换机器/换用户/文件损坏:GCM 认证失败抛出,由调用方按无数据处理
function unseal(sealed) {
  const [salt, iv, tag, ct] = String(sealed).split('.').map(s => Buffer.from(s, 'base64'));
  if (!salt || !iv || !tag || !ct) return null;
  const key = crypto.scryptSync(machineKeyMaterial(), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ===== token 存取 =====
function writeToken(token, expiresAt) {
  atomicWrite(TOKEN_FILE, JSON.stringify({
    v: 1,
    cipher: seal(token),
    expiresAt,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// 返回 { token, expiresAt } 或 null;坏记录返回 null 让调用方按"无 token"处理
function readToken() {
  try {
    const record = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    let token = null;
    if (record && typeof record.token === 'string') token = record.token; // 手工恢复用的明文格式
    else if (record && record.v === 1 && typeof record.cipher === 'string') {
      try { token = unseal(record.cipher); } catch (e) { /* 换机器/损坏:按无 token */ }
    }
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
    let password = null;
    try { password = unseal(raw.passwordCipher); } catch (e) { /* 换机器/损坏 */ }
    if (!password) return null;
    return {
      username: raw.username,
      password,
      fingerPrint: raw.fingerPrint,
      updatedAt: raw.updatedAt,
    };
  } catch (e) {
    // 固定文案:e.message 可能携带密文片段,不该进日志
    console.error('凭据读取失败(可能已换机器/用户或文件损坏),可重新运行 login 配置');
    return null;
  }
}

function writeAccount(username, password, fingerPrint) {
  const record = {
    username,
    passwordCipher: seal(password),
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

module.exports = {
  readToken, writeToken,
  readAccount, writeAccount, hasAccount,
};
