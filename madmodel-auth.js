// madmodel-auth.js
// 清华统一认证 → WebVPN → info 门户漫游 → madmodel token 全链(纯 Node 实现)。
// 协议知识来自 thu-learn-lib(MIT)/learnX(MIT)/thu-info-app 的公开行为,
// 本文件为独立实现(thu-info-app 的协议库 @thu-info/lib 为 BSL,未引用其任何代码)。
// 运行时依赖全部为 Node 原生:
//   - fetch(redirect:'manual') + getSetCookie() 逐跳管理 cookie
//   - sm2.js(sm-crypto v0.3.13,vendored)直接 require
// 输出:{ token, expiresAt } —— token 对直连端点 madmodel.cs.tsinghua.edu.cn 有效。

'use strict';

const crypto = require('crypto');

// sm2.js(jsbn 系 RNG)的熵池播种(vendored 源码核实):window.crypto 分支只把
// 32 字节 CSPRNG 写入 256 字节池的开头,其余 224 字节无条件由 Math.random 补齐,
// 播种与取字节过程中另有少量 Date.now() 字节 XOR 进池首,随后整池过 RC4 密钥编排。
// CSPRNG 的 32 字节(256 bit)真实熵意味着:即使 Math.random 输出全被还原,私钥仍
// 有 256 bit 不可预测。无 shim 时整池只剩 Math.random,熵完全依赖一个可被进程内
// 观察还原的非密码学随机源,密文(统一认证密码)可解。故此处强制断言生效的 crypto
// 是 CSPRNG,fail closed:既覆盖"无 window"(注入 shim),也覆盖"已有 window 但其
// crypto 不可用"(直接拒绝,不允许静默跳过 shim)。
const nodeCrypto = crypto.webcrypto;
if (!nodeCrypto || typeof nodeCrypto.getRandomValues !== 'function') {
  throw new Error('当前 Node.js 不提供 WebCrypto CSPRNG,拒绝加载熵池无法接入 CSPRNG 的 SM2 实现');
}
const createdWindowShim = typeof globalThis.window === 'undefined';
if (createdWindowShim) {
  globalThis.window = { crypto: nodeCrypto };
} else if (!(globalThis.window.crypto &&
    typeof globalThis.window.crypto.getRandomValues === 'function')) {
  throw new Error('globalThis.window 已存在但其 crypto 不可用,SM2 熵池无法接入 CSPRNG,拒绝加载');
}

const _smLib = require('./sm2.js');
// 播种只在 require 时发生,之后清掉自己注入的全局(sm2.js 运行期只用纯计算,
// 不再读 window);别人的 window(非本文件创建)不动
if (createdWindowShim) delete globalThis.window;
const sm2 = _smLib.sm2 && typeof _smLib.sm2.doEncrypt === 'function' ? _smLib.sm2 : _smLib;
if (!sm2 || typeof sm2.doEncrypt !== 'function') {
  throw new Error('SM2 加密库加载失败');
}

// 运行环境自检:登录链强依赖原生 fetch 与 Headers.getSetCookie(逐跳 Set-Cookie)。
// 旧 Node 上若静默降级,表现为难排查的登录失败;这里启动即报清楚。
if (typeof fetch !== 'function' || typeof Headers === 'undefined' ||
    typeof Headers.prototype.getSetCookie !== 'function') {
  throw new Error(`需要 Node.js 18.14+/19.7+(原生 fetch 与 Headers.getSetCookie),当前 ${process.version}`);
}
// id 系统页面是 gb2312/GBK,判读登录结果要按中文匹配,故要求 GBK 解码可用。
// nodejs.org 的官方构建自 Node 13 起均为 full-icu;仅自行裁剪的 small-icu 构建
// 会缺失。fail closed:静默退化会让"密码错误"之类的判断悄悄失效
try {
  new TextDecoder('gbk');
} catch (e) {
  throw new Error('当前 Node.js 缺少 GBK 解码支持(small-icu 构建),无法判读学校登录页,请改用 nodejs.org 官方构建');
}

// ===== 端点(实测于 2026-09,学校改版即失效) =====
const ID_PREFIX = 'https://id.tsinghua.edu.cn';
const WEBVPN_PREFIX = 'https://webvpn.tsinghua.edu.cn';
const WEBVPN_OAUTH_LOGIN = () => `${WEBVPN_PREFIX}/login?oauth_login=true`;
const ID_LOGIN_CHECK = () => `${ID_PREFIX}/do/off/ui/auth/login/check`;
const ID_DOUBLE_AUTH = () => `${ID_PREFIX}/b/doubleAuth/login`;
const ID_SAVE_FINGER = () => `${ID_PREFIX}/b/doubleAuth/personal/saveFinger`;
const ID_INFO_APP_FORM = () => `${ID_PREFIX}/do/off/ui/auth/login/form/10000ea055dd8d81d09d5a1ba55d39ad/0`;
const GET_COOKIE_URL = WEBVPN_PREFIX +
  '/wengine-vpn/cookie?method=get&host=info.tsinghua.edu.cn&scheme=https&path=/f/info/gxfw_fg/common/index';
const INFO_PREFIX = WEBVPN_PREFIX +
  '/https/77726476706e69737468656265737421f9f9479369247b59700f81b9991b2631506205de';
const ROAMING_URL = `${INFO_PREFIX}/b/yyfw/vyyfwxx/info/portal_fg/common/onlineAppRedirect`;
const MADMODEL_VPN_PREFIX = WEBVPN_PREFIX +
  '/https/77726476706e69737468656265737421fdf6459128346d5c300b9ae28c462a3b27469fc32211fa26a3e464';
const MADMODEL_AUTH_CHECK_URL = `${MADMODEL_VPN_PREFIX}/model-api/auth-login/check?ticket=`;
const MADMODEL_ROAMING_ID = '19D04E39D96B36C494F2E48A1A4741FD';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function AuthError(message, code) {
  const error = new Error(message);
  error.code = code || 'MADMODEL_AUTH_ERROR';
  return error;
}

// ===== HTTP 层:fetch + 手动重定向 + CookieJar =====

function hostOf(url) {
  const match = /^(https?:\/\/[^\/]+)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : '';
}

function pathOf(url) {
  const m = /^(https?:\/\/[^\/]+)(\/[^?#]*)?/.exec(String(url || ''));
  if (!m) return '/';
  return m[2] || '/';
}

function defaultCookiePath(url) {
  const p = pathOf(url);
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx + 1);
}

function cookiePathMatches(requestPath, cookiePath) {
  const cp = cookiePath || '/';
  return requestPath === cp || (requestPath.startsWith(cp) &&
    (cp.endsWith('/') || requestPath[cp.length] === '/'));
}

class CookieJar {
  constructor() { this.cookies = {}; }

  absorb(url, setCookieList) {
    const list = [];
    for (const raw of (Array.isArray(setCookieList) ? setCookieList : [setCookieList])) {
      if (!raw) continue;
      // 多个 Set-Cookie 可能合并成一行;只在下一个 cookie 名之前切分,避免误切 Expires 中的逗号
      list.push(...String(raw).split(/,(?=\s*[^;,=\s]+=[^;]*)/));
    }
    const domain = hostOf(url);
    if (!this.cookies[domain]) this.cookies[domain] = [];
    const jar = this.cookies[domain];
    for (const raw of list) {
      const parts = String(raw).split(';');
      const pair = parts[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      let cpath = defaultCookiePath(url);
      for (let i = 1; i < parts.length; i++) {
        const pm = /^Path=(.*)$/i.exec(parts[i].trim());
        if (pm) cpath = pm[1] || '/';
      }
      const existing = jar.findIndex(c => c.name === name && c.path === cpath);
      if (!value) {
        if (existing !== -1) jar.splice(existing, 1);
      } else if (existing === -1) {
        jar.push({ name, value, path: cpath });
      } else {
        jar[existing].value = value;
      }
    }
  }

  valueFor(url, name) {
    const p = pathOf(url);
    const matches = (this.cookies[hostOf(url)] || [])
      .filter(c => c.name === name && cookiePathMatches(p, c.path))
      .sort((a, b) => b.path.length - a.path.length);
    return matches.length ? matches[0].value : '';
  }

  headerFor(url) {
    const p = pathOf(url);
    const jar = this.cookies[hostOf(url)] || [];
    const seen = new Set();
    const parts = [];
    for (const c of jar.slice().sort((a, b) => b.path.length - a.path.length)) {
      if (seen.has(c.name)) continue;
      if (cookiePathMatches(p, c.path)) {
        seen.add(c.name);
        parts.push(`${c.name}=${c.value}`);
      }
    }
    return parts.join('; ');
  }

  clearOrigins(urls) {
    for (const url of (urls || [])) delete this.cookies[hostOf(url)];
  }
}

// resolveUrl:相对/绝对跳转解析(避免依赖 URL 类的怪异形态)
function resolveUrl(base, target) {
  if (!target) return base;
  if (/^https?:\/\//i.test(target)) return target;
  const m = /^(https?:\/\/[^\/]+)/i.exec(base);
  const origin = m ? m[1] : '';
  if (!origin) return target;
  if (target.indexOf('/') === 0) return origin + target;
  return base.replace(/[^\/]*$/, '') + target;
}

// 响应体解码。id 系统页面是 gb2312/GBK,JSON 接口是 UTF-8,而学校端点并不总是
// 声明 charset:先按声明解,没声明就试 UTF-8——出现替换字符(U+FFFD)说明不是
// 合法 UTF-8,退回 GBK 再解。
// 不能像从前那样统一按 latin1 逐字节读:GBK 汉字的尾字节落在 ASCII 区间
// (0x40-0x7E),逐字节判读会把汉字的后半截误当成结构字符;JSON 里的中文
// (二次认证的 msg 等)也会全是乱码。中文匹配改用字面量后,手工维护的 GBK
// 字节表连带消失——那张表里 "密码不正确" 的末字节曾错成 "雀",静默失配至今。
function decodeBody(buf, contentType) {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const label = (declared ? declared[1] : '').toLowerCase();
  const decode = enc => {
    try { return new TextDecoder(enc).decode(buf); } catch (e) { return null; }
  };
  if (label && !/^utf-?8$/.test(label)) {
    const declaredText = decode(label);
    if (declaredText !== null) return declaredText;
  }
  const utf8 = decode('utf-8');
  if (utf8 !== null && !utf8.includes('�')) return utf8;
  return decode('gbk') ?? utf8 ?? '';
}

function decodeHTML(html) {
  return String(html || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// fetch + 手动 302 跟随。返回 { statusCode, headers, body, finalUrl }。
// 学校登录链的 Set-Cookie 只在逐跳可见,fetch 自动重定向会吞掉中间跳的 cookie。
// 重定向目标限制在清华域(认证链全是校内域):防认证响应被篡改时把带
// Cookie/票据的请求引到任意外部地址(SSRF/票据泄露面)。
// 用 URL 解析而非正则取主机:userinfo(https://x.tsinghua.edu.cn:443@evil/)会把
// authority 前缀伪装成校内域——正则在冒号处截断正好被骗过,URL().hostname 才是真实主机。
const REDIRECT_HOST_ALLOW = /^[\w.-]+\.tsinghua\.edu\.cn$/i;
function isAllowedRedirect(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return false; }
  return u.protocol === 'https:' &&
    u.username === '' && u.password === '' &&
    REDIRECT_HOST_ALLOW.test(u.hostname);
}
// 弱一档的主机检查(允许 http,用于校验 OAuth 回跳地址的来源),同样基于 URL 解析
function isCampusHost(url) {
  try { return REDIRECT_HOST_ALLOW.test(new URL(String(url || '')).hostname); }
  catch (e) { return false; }
}
// 认证链响应体上限:超时限制的是时间不是字节,异常/被攻陷的校内端点可以在
// 超时前倾倒巨量内容把 watch 进程内存打爆。登录页/JSON 应答均在数十 KB 量级,
// 5MB 上限余量充分;超限直接放弃(与代理侧 readLimited 同一哲学)
const AUTH_BODY_LIMIT = 5 * 1024 * 1024;
async function readBodyLimited(res) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > AUTH_BODY_LIMIT) {
      try { await reader.cancel(); } catch (e) { /* 已断 */ }
      throw new Error(`认证响应体超过 ${AUTH_BODY_LIMIT / 1048576}MB 上限,疑似异常响应,已中止`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

async function requestWithRedirects(options, jar, maxRedirects = 16) {
  let url = options.url;
  let method = options.method || 'GET';
  let data = options.data;
  for (let hops = 0; ; hops++) {
    if (!isAllowedRedirect(url)) throw new Error(`认证请求目标非清华 HTTPS 域,已中止: ${url}`);
    const cookieHeader = jar.headerFor(url);
    const headers = {
      'User-Agent': USER_AGENT,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(options.header || {}),
    };
    let body = null;
    if (data != null) {
      if (typeof data === 'string') {
        body = data;
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        body = Object.keys(data)
          .map(k => `${k}=${encodeURIComponent(data[k])}`)
          .join('&');
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method, headers, body, redirect: 'manual',
        signal: AbortSignal.timeout(options.timeout || 20000),
      });
    } catch (e) {
      // 不能给 DOMException 挂 code:AbortSignal.timeout 抛的 TimeoutError 自带
      // 只读数值访问器 code(=23),strict 下赋值抛 TypeError,会吞掉原错误。
      // 统一包成带 code 的 Error,原错误留在 cause。
      // AbortError 暂与超时同档:当前 signal 只来自 AbortSignal.timeout(),没有
      // 外部取消来源;若将来引入外部中止(如 Ctrl+C 打断登录链),必须拆开,
      // 否则用户主动取消会被当成网络超时"容忍并重试"
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      const err = new Error(`网络请求失败: ${e.message}`, { cause: e });
      err.code = timeout ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR';
      throw err;
    }
    jar.absorb(url, res.headers.getSetCookie());

    const redirect = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && redirect) {
      if (hops >= maxRedirects) {
        const err = new Error('重定向次数过多');
        err.code = 'TOO_MANY_REDIRECTS';
        throw err;
      }
      const next = resolveUrl(url, redirect);
      if (!isAllowedRedirect(next)) {
        // 首跳目标(即请求发起的域)必然合法;此处拒绝的是链中被带偏的后续跳
        if (hops === 0) throw new Error(`重定向目标非清华域: ${next}`);
        throw new Error(`登录链重定向被引向校外地址,已中止(可能被篡改): ${next}`);
      }
      url = next;
      // 307/308 按语义保留 method 与 body;301/302/303 转 GET 并丢 body
      // (学校登录链现全部 302,实测验证;若哪天出现 307,POST 数据不再静默丢失)
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        data = null;
      }
      continue;
    }
    const buf = await readBodyLimited(res);
    return {
      statusCode: res.status,
      headers: res.headers,
      body: decodeBody(buf, res.headers.get('content-type')),
      finalUrl: url,
    };
  }
}

function firstAnchorUrl(body, baseUrl) {
  const match = /<a[^>]+href\s*=\s*["']([^"']+)["']/i.exec(String(body || ''));
  return match && match[1] ? resolveUrl(baseUrl, decodeHTML(match[1])) : '';
}

function extractPageRedirectUrl(body, baseUrl) {
  const text = String(body || '');
  const meta = /<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"']+)["']/i.exec(text);
  if (meta && meta[1]) return resolveUrl(baseUrl, decodeHTML(meta[1].trim()));
  const js = /location\.(?:href|replace)\s*[=(]\s*["']([^"']+)["']/i.exec(text);
  if (js && js[1]) return resolveUrl(baseUrl, decodeHTML(js[1].trim()));
  return '';
}

// ===== 认证客户端 =====

class MadmodelAuthClient {
  constructor(jar) {
    this.jar = jar || new CookieJar();
    this.portalCsrf = '';
  }

  // ID 登录表单提交:SM2 加密密码 → POST /check → 成功页锚点。
  // formVariant 'thuinfo':action 一律用 checkUrl(表单由 id 域提供)。
  async authenticateIdentity(formUrl, checkUrl, username, password, fingerPrint,
    twoFactorHandler, existingFormPage, formVariant) {
    const formPage = existingFormPage ||
      await requestWithRedirects({ url: formUrl }, this.jar);
    const formBody = String(formPage.body || '');
    const pubKeyMatch = /id=["']sm2publicKey["'][^>]*>([^<]+)</.exec(formBody) ||
      /sm2publicKey['"]?\s*[:=]\s*['"]([0-9a-fA-F]+)['"]/.exec(formBody);
    if (!pubKeyMatch || !pubKeyMatch[1]) {
      throw AuthError('无法获取登录公钥,学校登录页可能已改版', 'NO_PUBLIC_KEY');
    }

    const formData = {
      i_user: username,
      i_pass: `04${sm2.doEncrypt(password, pubKeyMatch[1].trim())}`,
      fingerPrint: fingerPrint || '',
      fingerGenPrint: '',
      i_captcha: '',
    };
    if (formVariant !== 'thuinfo') {
      formData.singleLogin = 'on';
      formData.fingerGenPrint3 = '';
    }
    const submitUrl = checkUrl;

    const checkRes = await requestWithRedirects({
      url: submitUrl, method: 'POST', data: formData,
    }, this.jar);
    let body = String(checkRes.body || '');
    const isSuccessfulBody = value =>
      (/ticket=/i.test(value) && !/ticket=BAD_CREDENTIALS/i.test(value)) ||
      value.includes('登录成功') || value.includes('正在重定向');
    const anchorBase = checkRes?.finalUrl || submitUrl;
    let redirectUrl = isSuccessfulBody(body) ? firstAnchorUrl(body, anchorBase) : '';

    if (!redirectUrl) {
      const hasLoginErrorBox = /<form\b/i.test(body) && /msg_note/i.test(body) && !/ticket=/i.test(body);
      const badCreds = body.includes('密码不正确') || body.includes('用户名或密码') ||
        body.includes('密码错误') ||
        /ticket=BAD_CREDENTIALS/i.test(body) || hasLoginErrorBox;
      let twoFactorSignal = body.includes('二次认证') || body.includes('验证码');
      let approaches = null;
      if (badCreds) throw AuthError('学号或密码不正确,请检查后重试', 'BAD_CREDENTIALS');
      if (!twoFactorSignal && checkRes.statusCode === 200 && typeof twoFactorHandler === 'function') {
        try {
          approaches = await this.findTwoFactorApproaches();
          twoFactorSignal = true;
        } catch (e) { /* 当前会话不需要或不支持二次认证 */ }
      }
      if (twoFactorSignal) {
        if (typeof twoFactorHandler !== 'function') {
          throw AuthError('学校要求二次认证(新设备验证),需要人工介入', 'TWO_FACTOR_REQUIRED');
        }
        body = await this.completeTwoFactor(fingerPrint, twoFactorHandler, approaches);
        redirectUrl = isSuccessfulBody(body) ? firstAnchorUrl(body, `${ID_PREFIX}/`) : '';
      }
    }

    if (!redirectUrl) {
      if (body.includes('出错了')) {
        throw AuthError('学校服务处理出错,请稍后重试', 'SERVER_ERROR');
      }
      throw AuthError(`登录失败(HTTP ${checkRes.statusCode},响应 ` +
        `${String(body || '').slice(0, 80).replace(/\s+/g, ' ')}…)`, 'LOGIN_FAILED');
    }
    return { body, redirectUrl, anchorBase };
  }

  async requestAuthAction(data, fallbackMessage) {
    const res = await requestWithRedirects({
      url: ID_DOUBLE_AUTH(), method: 'POST', data,
    }, this.jar);
    let json;
    try { json = JSON.parse(res.body || '{}'); } catch (e) {
      throw AuthError(`${fallbackMessage}:学校返回了无法识别的数据`, 'TWO_FACTOR_INVALID_RESPONSE');
    }
    if (res.statusCode !== 200 || json.result !== 'success') {
      throw AuthError(json.msg || fallbackMessage, 'TWO_FACTOR_FAILED');
    }
    return json;
  }

  findTwoFactorApproaches() {
    return this.requestAuthAction({ action: 'FIND_APPROACHES' }, '无法获取学校验证方式');
  }

  // 二次认证:handler({stage:'method'}) 选方式 → 发码 → handler({stage:'code'}) 要码
  // → 校验 → saveFinger 登记可信设备(此后同指纹登录免二次认证)。
  async completeTwoFactor(fingerPrint, handler, knownApproaches) {
    const approaches = knownApproaches || await this.findTwoFactorApproaches();
    const info = approaches.object || {};
    const methods = [];
    if (info.hasWeChatBool) methods.push('wechat');
    if (info.phone !== null && info.phone !== undefined) methods.push('mobile');
    if (info.hasTotp) methods.push('totp');
    if (!methods.length) {
      throw AuthError('学校要求二次认证,但账号未配置可用验证方式', 'TWO_FACTOR_NO_METHOD');
    }
    // 手机号先本地打码再交给 handler:上游未打码时避免全号进日志/终端回显
    const maskPhone = p => String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') || String(p || '');
    const selection = await handler({ stage: 'method', methods, phone: maskPhone(info.phone) });
    if (!selection) throw AuthError('已取消学校身份验证', 'TWO_FACTOR_CANCELLED');
    const method = typeof selection === 'string' ? selection : selection.method;
    const trustDevice = typeof selection === 'object' ? selection.trustDevice !== false : true;
    if (methods.indexOf(method) === -1) {
      throw AuthError('所选验证方式不可用', 'TWO_FACTOR_INVALID_METHOD');
    }
    await this.requestAuthAction({ action: 'SEND_CODE', type: method }, '学校验证码发送失败');
    const code = String((await handler({ stage: 'code', method, phone: maskPhone(info.phone) })) || '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw AuthError(code ? '学校验证码应为六位数字' : '已取消学校身份验证', 'TWO_FACTOR_CANCELLED');
    }
    const verified = await this.requestAuthAction(
      { action: method === 'totp' ? 'VERITY_TOTP_CODE' : 'VERITY_CODE', vericode: code },
      '学校验证码校验失败');
    if (trustDevice) {
      try {
        const saved = await requestWithRedirects({
          url: ID_SAVE_FINGER(), method: 'POST',
          data: { fingerprint: fingerPrint, deviceName: 'dsh-madmodel', radioVal: '是' },
        }, this.jar);
        const savedJson = JSON.parse(saved.body || '{}');
        if (savedJson.result !== 'success') console.warn('学校未能登记可信设备:', savedJson.msg);
      } catch (e) {
        console.warn('可信设备登记失败,本次继续登录:', e.message);
      }
    }
    const redirectUrl = verified.object && verified.object.redirectUrl;
    if (!redirectUrl) {
      throw AuthError('学校验证成功但未返回登录跳转地址', 'TWO_FACTOR_NO_REDIRECT');
    }
    const completed = await requestWithRedirects({
      url: resolveUrl(`${ID_PREFIX}/`, redirectUrl),
    }, this.jar);
    return completed.body;
  }

  // ===== WebVPN 会话 =====

  async attemptWebVpnLoginOnce(username, password, fingerPrint, twoFactorHandler) {
    this.jar.clearOrigins([ID_PREFIX, WEBVPN_PREFIX]);
    await requestWithRedirects({ url: WEBVPN_OAUTH_LOGIN() }, this.jar);
    const oauth = await requestWithRedirects({ url: WEBVPN_OAUTH_LOGIN() }, this.jar);
    const oauthNeedsLogin = /^https:\/\/id\.tsinghua\.edu\.cn\//i.test(oauth.finalUrl || '') ||
      /id=["']sm2publicKey["']/i.test(oauth.body || '') ||
      /sm2publicKey['"]?\s*[:=]\s*['"][0-9a-fA-F]+['"]/i.test(oauth.body || '');
    if (oauthNeedsLogin) {
      // 跨域 302 的表单会话 cookie 归位:fetch 手动重定向时 Set-Cookie 按请求 URL
      // 记录,但表单实际由 id 域提供。fetch 每跳都按当前 URL absorb,归位逻辑
      // 仅为防御(通常已经正确)。
      if (!/^https:\/\/id\.tsinghua\.edu\.cn\//i.test(oauth.finalUrl || '')) {
        const webvpnFormSession = this.jar.valueFor(WEBVPN_OAUTH_LOGIN(), 'JSESSIONID');
        if (webvpnFormSession && !this.jar.valueFor(`${ID_PREFIX}/`, 'JSESSIONID')) {
          this.jar.absorb(`${ID_PREFIX}/`, `JSESSIONID=${webvpnFormSession}; Path=/`);
          console.warn('[WebVPN] ID 表单会话 cookie 已归位到 id 域');
        }
      }
      const direct = await this.authenticateIdentity(
        oauth.finalUrl || WEBVPN_OAUTH_LOGIN(),
        ID_LOGIN_CHECK(), username, password, fingerPrint, twoFactorHandler,
        oauth, 'thuinfo');
      if (!isCampusHost(direct.redirectUrl)) {
        throw AuthError('WebVPN OAuth 返回了未允许的跳转地址', 'WEBVPN_OAUTH_REDIRECT');
      }
      try {
        const callbackRes = await requestWithRedirects({ url: direct.redirectUrl }, this.jar);
        if (callbackRes.statusCode === 200) {
          const nextUrl = extractPageRedirectUrl(callbackRes.body, direct.redirectUrl);
          if (nextUrl) await requestWithRedirects({ url: nextUrl }, this.jar);
        }
      } catch (e) {
        console.warn('[WebVPN] 回调跟随未完成(继续验证会话):', e.message);
      }
    }
  }

  async verifyWebVpnSession() {
    try {
      const probe = await requestWithRedirects({ url: WEBVPN_OAUTH_LOGIN() }, this.jar);
      return /sm2publicKey/i.test(String(probe.body || '')) === false;
    } catch (e) { return false; }
  }

  // oauth 域锚点 → lb-auth/lbredirect 形式(uri 不编码)。URL 形式对齐
  // thu-info-lib 的公开行为——是学校接口的协议事实,非代码引用(BSL,未引用)
  toLbRedirectUrl(urlIn) {
    const value = String(urlIn || '');
    if (/oauth\.tsinghua\.edu\.cn/i.test(value)) return value;
    const m = /^(https?):\/\/([^\/:?]+)(?::(\d+))?([^\?#]*)(\?[^#]*)?(#[^]*)?$/i.exec(value);
    if (!m) return value;
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const port = m[3] || (scheme === 'https' ? '443' : '80');
    const uri = (m[4] || '/') + (m[5] || '') + (m[6] || '');
    return 'https://oauth.tsinghua.edu.cn/lb-auth/lbredirect' +
      `?scheme=${scheme}&host=${host}&port=${port}&uri=${uri}`;
  }

  // ID 漫游到 info 门户:建立门户侧会话,否则漫游接口不返回 roamingurl。
  async roamToInfoPortal(username, password, fingerPrint, twoFactorHandler) {
    const formUrl = ID_INFO_APP_FORM();
    const formPage = await requestWithRedirects({ url: formUrl }, this.jar);
    if (!/sm2publicKey/i.test(String(formPage.body || ''))) {
      console.warn('[WebVPN] info 应用表单未出现登录表单(会话可能已建立)');
      return true;
    }
    const identity = await this.authenticateIdentity(
      formUrl, ID_LOGIN_CHECK(), username, password, fingerPrint, twoFactorHandler,
      formPage, 'thuinfo');
    if (!identity.redirectUrl) {
      throw AuthError('info 门户漫游未返回跳转地址', 'WEBVPN_INFO_ROAM_EMPTY');
    }
    const targetUrl = this.toLbRedirectUrl(identity.redirectUrl);
    // 打日志前显式剥掉 ticket/_csrf 等敏感查询参数(不能靠截断长度来"碰巧"截掉)
    console.warn('[WebVPN] info 漫游跟随', String(targetUrl)
      .replace(/([?&])(ticket|_csrf|oauth_token)=[^&]*/gi, '$1$2=***')
      .slice(0, 120));
    try {
      await requestWithRedirects({ url: targetUrl }, this.jar);
    } catch (e) {
      console.warn('[WebVPN] info 漫游跳转未完成(继续由后续请求验证):', e.message);
    }
    return true;
  }

  async establishWebVpnSession(username, password, fingerPrint, twoFactorHandler) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.attemptWebVpnLoginOnce(username, password, fingerPrint, twoFactorHandler);
      } catch (e) {
        // 网络层错误(重定向循环/超时/连接失败)不代表登录失败——服务端可能已完成
        // 登录;按 code 判定,不匹配错误文案
        if (!['TOO_MANY_REDIRECTS', 'NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(e.code)) throw e;
        console.warn('[WebVPN] 登录链网络层错误(容忍并验证会话):', e.message);
      }
      if (await this.verifyWebVpnSession()) {
        if (attempt > 1) console.warn('[WebVPN] 第', attempt, '次登录后会话已建立');
        await this.roamToInfoPortal(username, password, fingerPrint, twoFactorHandler);
        return;
      }
      console.warn('[WebVPN] 第', attempt, '次登录后未见会话', attempt < 2 ? ',重试' : '');
    }
    throw AuthError('WebVPN 登录后未能建立会话', 'THUINFO_WEBVPN_LOGIN');
  }

  // ===== info 门户 CSRF =====

  async readPortalCsrf() {
    let pageCsrf = '';
    try {
      const idx = await requestWithRedirects({
        url: `${INFO_PREFIX}/f/info/gxfw_fg/common/index`,
      }, this.jar, 12);
      const m = /_csrf=([\w-]+)/.exec(String(idx.body || ''));
      if (m) pageCsrf = m[1];
    } catch (e) {
      console.warn('[WebVPN] info首页预热失败:', String(e.message).slice(0, 80));
    }
    const response = await requestWithRedirects({ url: GET_COOKIE_URL }, this.jar, 12);
    const cookieBody = String(response.body || '');
    // body 形如 "XSRF-TOKEN=<uuid>\n",必须用 [^\s;] 匹配换行前的值
    const match = /XSRF-TOKEN=([^\s;]+)/.exec(cookieBody);
    let token = match && match[1] ? match[1] : '';
    if (!token) token = this.jar.valueFor(WEBVPN_PREFIX, 'XSRF-TOKEN') || '';
    if (!token && pageCsrf) token = pageCsrf;
    if (!token) return '';
    try { return decodeURIComponent(token); } catch (e) { return token; }
  }

  async ensureWebVpnSession(username, password, fingerPrint, twoFactorHandler) {
    let token = '';
    try { token = await this.readPortalCsrf(); } catch (e) { /* continue OAuth */ }
    if (!token) {
      await this.establishWebVpnSession(username, password, fingerPrint, twoFactorHandler);
      token = await this.readPortalCsrf();
    }
    if (!token) {
      throw AuthError('无法建立 thuInfo WebVPN 会话', 'THUINFO_WEBVPN_LOGIN');
    }
    this.portalCsrf = token;
  }

  // ===== madmodel token =====

  // 漫游 JSON 的 roamingurl 可能带 WebVPN 前缀(https://webvpn.../https/HASH/...)
  // 也可能直指原站;统一剥出 ticket 所在的目标 URL。
  mapRoamingUrl(url) {
    let value = decodeHTML(String(url || '')).replace(/&amp;/g, '&');
    const vpnPrefix = /^https:\/\/webvpn\.tsinghua\.edu\.cn\/https\/([0-9a-f]+)\//i.exec(value);
    if (vpnPrefix) {
      value = `https://${Buffer.from(vpnPrefix[1], 'hex').toString('utf8')}`;
    }
    return value;
  }

  async resolveRoamingTarget(payload, label, credentials) {
    if (!this.portalCsrf) await this.ensureWebVpnSession(
      credentials.username, credentials.password, credentials.fingerPrint,
      credentials.twoFactorHandler);
    const doRoam = async () => {
      const response = await requestWithRedirects({
        url: `${ROAMING_URL}?yyfwid=${encodeURIComponent(payload)}` +
          `&_csrf=${encodeURIComponent(this.portalCsrf)}&machine=p`,
      }, this.jar, 12);
      if (response.statusCode !== 200) {
        throw AuthError(`${label}漫游失败(HTTP ${response.statusCode})`, 'THUINFO_ROAM_HTTP');
      }
      return response.body;
    };
    let body = await doRoam();
    let json = null;
    try { json = JSON.parse(String(body || '')); } catch (e) { /* fallthrough */ }
    if (json && json.object && json.object.roamingurl) {
      return this.mapRoamingUrl(json.object.roamingurl);
    }
    // 无 roamingurl:门户会话缺失,强制重建后重试(实测验证的模式)
    const keys = json ? Object.keys(json).join(',') : '非JSON';
    console.warn(`[thuInfo] ${label}漫游无跳转地址,重建会话后重试(响应键=${keys})`);
    this.portalCsrf = '';
    await this.establishWebVpnSession(
      credentials.username, credentials.password, credentials.fingerPrint,
      credentials.twoFactorHandler);
    body = await doRoam();
    try { json = JSON.parse(String(body || '')); } catch (e) {
      throw AuthError(label + '漫游返回非 JSON', 'THUINFO_NOT_JSON');
    }
    const roamingUrl = json && json.object && json.object.roamingurl;
    if (!roamingUrl) {
      throw AuthError(label + '漫游未返回跳转地址', 'THUINFO_ROAM_EMPTY');
    }
    return this.mapRoamingUrl(roamingUrl);
  }

  // 全链入口:返回 { token, expiresAt(ms) }
  async getMadModelToken(credentials) {
    const target = await this.resolveRoamingTarget(MADMODEL_ROAMING_ID, 'madmodel', credentials);
    const ticketMatch = /[?&]ticket=([^&#]+)/i.exec(target);
    if (!ticketMatch || !ticketMatch[1]) {
      throw AuthError('madmodel 漫游未返回 ticket', 'THUINFO_MADMODEL_TICKET');
    }
    let ticket = ticketMatch[1];
    try { ticket = decodeURIComponent(ticket); } catch (e) { /* keep raw */ }

    const entryResponse = await requestWithRedirects({ url: target }, this.jar, 16);
    if (entryResponse.statusCode !== 200) {
      throw AuthError('madmodel 漫游入口请求失败', 'THUINFO_MADMODEL_ENTRY');
    }
    const authResponse = await requestWithRedirects({
      url: MADMODEL_AUTH_CHECK_URL + encodeURIComponent(ticket),
    }, this.jar, 12);
    if (authResponse.statusCode !== 200) {
      throw AuthError('madmodel 认证请求失败', 'THUINFO_MADMODEL_AUTH');
    }
    let json;
    try { json = JSON.parse(authResponse.body); }
    catch (e) { throw AuthError('madmodel 认证返回非 JSON', 'THUINFO_MADMODEL_TOKEN'); }
    const token = json && json.data;
    if (typeof token !== 'string' || !token.trim()) {
      throw AuthError('madmodel 认证未返回 token', 'THUINFO_MADMODEL_TOKEN');
    }
    return {
      token: token.trim(),
      expiresAt: jwtExpiresAt(token.trim()),
    };
  }
}

// JWT exp 解码(payload 第二段 base64url);解析失败返回 now+5h 兜底。
function jwtExpiresAt(token) {
  try {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch (e) { /* fallthrough */ }
  return Date.now() + 5 * 3600 * 1000;
}

// 复刻 learnX 的指纹形态:32 个十六进制字符(16 字节)
function generateFingerprint() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  MadmodelAuthClient,
  CookieJar,
  jwtExpiresAt,
  generateFingerprint,
  AuthError,
  requestWithRedirects,
  // 以下为认证链中出错概率最高的纯判定函数(响应体解码/URL 解析/重定向白名单)。
  // 认证链无法端到端离线验证,单独导出便于本地复现与审查
  decodeBody,
  resolveUrl,
  isAllowedRedirect,
};

