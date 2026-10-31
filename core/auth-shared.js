// 无认证协议或启动副作用的共享端点与凭据格式工具。
'use strict';
const { randomBytes } = require('node:crypto');
const WEBVPN_PREFIX = 'https://webvpn.tsinghua.edu.cn';
// wengine: hex(IV) + hex(AES-128-CFB(host)); 推导见 tunnel-prefix.test.js。
const INFO_PREFIX = WEBVPN_PREFIX +
  '/https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de';
const MADMODEL_VPN_PREFIX = WEBVPN_PREFIX +
  '/https/77726476706e69737468656265737421fdf6459128346d5c300b9ae28c462a3b27469fc32211fa26a3e464';
const MADMODEL_TUNNEL_MODELS_URL = `${MADMODEL_VPN_PREFIX}/v1/models`;
const TUNNEL_COOKIE_SCOPE = `${MADMODEL_VPN_PREFIX}/`;
function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch { /* 保留历史兼容：无法解析的 token 交上游验证。 */ }
  return Date.now() + 5 * 3600 * 1000;
}
const generateFingerprint = () => randomBytes(16).toString('hex');
module.exports = { WEBVPN_PREFIX, INFO_PREFIX, MADMODEL_VPN_PREFIX,
  MADMODEL_TUNNEL_MODELS_URL, TUNNEL_COOKIE_SCOPE, jwtExpiresAt, generateFingerprint };
