// platform/linux/credentials.js
// Linux 密钥原语:机器绑定 AES-256-GCM。密钥由 /etc/machine-id + 当前
// uid/用户名经 scrypt 派生,每次写入换新盐防离线比对。文件被拷贝或同步到
// 其他机器/账户后解不开(读回按"无数据"处理,重新 login 即可)——堵住
// 状态目录(~/.madmodel-proxy)点文件被云同步、误提交进 git 的现实威胁;
// 本机同用户进程
// 可解,这是任何本地凭据方案的等价下界(DPAPI 同样挡不住)。
// 不用 secret-tool(D-Bus Secret Service):无人值守守护在无桌面会话/SSH
// 下读不了锁着的 keyring,那是最脆的依赖。
// 存储骨架(读写语义/文件形态)见 ../credential-store。

'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const createFileCredentialStore = require('../credential-store');

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

// 换机器/换用户/文件损坏:GCM 认证失败抛出,由骨架按无数据处理
function unseal(sealed) {
  const [salt, iv, tag, ct] = String(sealed).split('.').map(s => Buffer.from(s, 'base64'));
  if (!salt || !iv || !tag || !ct) return null;
  const key = crypto.scryptSync(machineKeyMaterial(), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = createFileCredentialStore({
  protect: seal,
  unprotect: unseal,
});
