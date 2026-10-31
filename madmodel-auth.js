// madmodel-auth.js
// 清华统一认证 → WebVPN → info 门户漫游 → madmodel token 全链(纯 Node 实现)。
// 协议知识来自 thu-learn-lib(MIT)/learnX(MIT)/thu-info-app 的公开行为,
// 本文件为独立实现(thu-info-app 的协议库 @thu-info/lib 为 BSL,未引用其任何代码)。
// 运行时依赖全部为 Node 原生:
//   - fetch(redirect:'manual') + getSetCookie() 逐跳管理 cookie
//   - sm2.js(sm-crypto v0.3.13,vendored)直接 require
// 输出:{ token, expiresAt, cookie } —— token 对 madmodel 应用有效(2026-09-10 起
// 直连域名被 TsinghuaLB oauth 门禁拦截,上游调用应走 WebVPN 隧道并携带 cookie)。

'use strict';

const crypto = require('crypto');
const { WEBVPN_PREFIX, INFO_PREFIX, MADMODEL_VPN_PREFIX, MADMODEL_TUNNEL_MODELS_URL,
  TUNNEL_COOKIE_SCOPE, jwtExpiresAt, generateFingerprint } = require('./core/auth-shared');

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
const WEBVPN_OAUTH_LOGIN = () => `${WEBVPN_PREFIX}/login?oauth_login=true`;
const ID_LOGIN_CHECK = () => `${ID_PREFIX}/do/off/ui/auth/login/check`;
const ID_DOUBLE_AUTH = () => `${ID_PREFIX}/b/doubleAuth/login`;
const ID_SAVE_FINGER = () => `${ID_PREFIX}/b/doubleAuth/personal/saveFinger`;
// 末段是 info 门户在 id 域的 appId(学校侧固定值,非本仓库生成)
const ID_INFO_APP_FORM = () => `${ID_PREFIX}/do/off/ui/auth/login/form/10000ea055dd8d81d09d5a1ba55d39ad/0`;
// 隧道自带接口(非学校业务接口):按 host/scheme/path 向隧道换取该应用的 cookie
const GET_COOKIE_URL = WEBVPN_PREFIX +
  '/wengine-vpn/cookie?method=get&host=info.tsinghua.edu.cn&scheme=https&path=/f/info/gxfw_fg/common/index';
// INFO_PREFIX / MADMODEL_VPN_PREFIX 末段的 HASH:hex(IV)+hex(AES-128-CFB(主机名)),
// 密钥与 IV 同为 ASCII 口令 wrdvpnisthebest!(wengine 固定常量)。学校换主机名时
// 按 test/tunnel-prefix.test.js 的 derive() 重新生成
const ROAMING_URL = `${INFO_PREFIX}/b/yyfw/vyyfwxx/info/portal_fg/common/onlineAppRedirect`;
const MADMODEL_AUTH_CHECK_URL = `${MADMODEL_VPN_PREFIX}/model-api/auth-login/check?ticket=`;
// madmodel 隧道内 models 地址:登录期会话判定(verifyWebVpnSession)与 config.js
// 保活探测(keepaliveUrl)共用的探测目标——单一来源,防两处路径漂移后
// "登录判定与保活探的不是同一条路径"的静默错位
// 取隧道 cookie 的作用域。**必须是隧道前缀**(而非 webvpn 域根):隧道的会话
// cookie 可能设在 Path=/https/<hash> 这种深路径上,按根路径匹配会漏掉它;
// 按隧道前缀匹配同时也排除同域其他应用(如 info 门户)的 cookie。
// 导出给上游与会话探测共用此常量,防两处各写一个 URL 后悄悄漂开
// madmodel 应用在 info 门户的漫游 ID(门户页面里的 yyfwid 参数值)
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
      // 删除 cookie 有三种标准写法,只看"值为空"会漏掉后两种,于是服务端
      // 已经作废的会话 cookie 会被我们继续发出去(2026-09-22 实测:
      // Max-Age=0 后旧值仍在)。两种都要识别:
      //   Max-Age:相对秒数,<=0 即立即过期
      //   Expires:绝对时间,已过去即过期
      // 按 RFC 6265 §5.3,**两者并存时 Max-Age 优先**,Expires 被忽略——否则
      // "过去的 Expires + 正数 Max-Age"这种组合会被误删(它本身自相矛盾,合规
      // 实现是按 Max-Age 保留)。故这里先扫全属性再判定,不能边扫边置位
      let maxAge = null;
      let expiresAt = null;
      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i].trim();
        const pm = /^Path=(.*)$/i.exec(attr);
        if (pm) { cpath = pm[1] || '/'; continue; }
        // 容忍空格与引号包裹、以及显式 + 号:服务端的写法并不总是最规范形态,
        // 收紧到只认 "-?\d+" 会静默漏删(2026-09-22 实测 Max-Age = 0 /
        // Max-Age=+0 / Max-Age="0" 三种都不生效)
        const mm = /^Max-Age\s*=\s*"?([+-]?\d+)"?$/i.exec(attr);
        if (mm) { maxAge = Number(mm[1]); continue; }
        const em = /^Expires\s*=\s*(.+)$/i.exec(attr);
        if (em) {
          const when = Date.parse(em[1]);
          if (Number.isFinite(when)) expiresAt = when;
        }
      }
      const expired = maxAge !== null
        ? maxAge <= 0
        : (expiresAt !== null && expiresAt <= Date.now());
      const existing = jar.findIndex(c => c.name === name && c.path === cpath);
      if (!value || expired) {
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
  return new URL(target, base).href;
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
// 展示用脱敏:剥掉查询串里的票据类参数值(ticket/_csrf/oauth_token),其余
// 原样保留(非敏感参数照旧可见,便于排障)。
// 只用于错误消息与日志——**不可用于将要发出的请求**:认证链的重定向本来就靠
// ticket 串联,改了值就断链。不能用"截断整条 URL"代替:那样既丢掉排障需要的
// 路径,又只是把秘密挪到看不见的位置(票据仍在内存与日志行长度里)
function redactUrl(text) {
  // 值有"带引号"与"裸值"两种形态,都要整体替换:
  //   ?ticket="SEC"  → ?ticket=***   (整体,含引号)
  //   ?ticket=SEC&x  → ?ticket=***&x (裸值吃到 & 前)
  // 裸值字符类不含空白与引号/尖括号——这样同一函数既能用在 URL 上,也能用在
  // HTML 片段上(如响应体里的 location.replace("/x?ticket=…")):若不排除引号,
  // 匹配会贪婪吞掉引号与后续闭合标签。反过来,若只排除引号而不单独处理"带引号
  // 的值",引号后的内容会继续泄漏(?ticket="SEC" 只脱掉引号前的部分)——
  // 2026-09-21 审阅指出。用在纯 URL 上三者与原行为等价(已逐例对照)
  // 分隔符要同时认 ?、& 与 HTML 转义的 &amp; —— 响应体是 HTML 时,其中的 URL
  // 通常把 & 写成 &amp; ,只认裸 & 会让第二个及以后的敏感参数完全不脱敏
  // (2026-09-22 审阅指出,实测:?ticket=PUBLIC&amp;_csrf=SECRET 的 _csrf 原样
  // 留在消息里)。捕获组带上分隔符本身,替换时原样保留
  // 值的引号还要认 HTML 实体形态(&quot;/&#34;/&#39;/&apos;):HTML 属性值里带引号时,
  // 规范写法就是把引号转义成实体。只认裸引号时 <a href="…?ticket=&quot;SEC&quot;">
  // 会脱掉 = 前的部分、把实体包裹的值整段留下(2026-09-24 实测各实体均泄漏)。
  // 实体分支的值类**不排空白**(只排 & < > 与换行):值由成对实体引号闭合,
  // 内含空格不会贪婪外溢;而排除空白会让"值里带空格"的形态重新泄漏
  // ——LOGIN_FAILED 先做 \s+→' ' 归一化再脱敏,属性值里的换行恰好变成空格,
  // 那条路径实测可达(2026-09-24)。裸值分支仍排除空白:它没有闭合标记兜底,
  // 放宽会吞掉后续结构
  return String(text || '').replace(
    /([?&](?:amp;)?)(ticket|_csrf|oauth_token)=("[^"]*"|'[^']*'|&(?:quot|#0*34|#[xX]0*22);[^&<>\n]*&(?:quot|#0*34|#[xX]0*22);|&(?:apos|#0*39|#[xX]0*27);[^&<>\n]*&(?:apos|#0*39|#[xX]0*27);|[^&#\s"'<>]*)/gi,
    '$1$2=***',
  );
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
    if (!isAllowedRedirect(url)) throw new Error(`认证请求目标非清华 HTTPS 域,已中止: ${redactUrl(url)}`);
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
      // 每一条重定向出口都丢弃响应体，包括跳数超限、地址非法和目标被拒绝。
      // 不等到校验成功后才取消，否则失败的认证链会把连接留到超时或 GC。
      try { await res.body?.cancel(); } catch (e) { /* 已结束/无 body */ }
      if (hops >= maxRedirects) {
        const err = new Error('重定向次数过多');
        err.code = 'TOO_MANY_REDIRECTS';
        throw err;
      }
      const next = resolveUrl(url, redirect);
      if (!isAllowedRedirect(next)) {
        // 首跳目标(即请求发起的域)必然合法;此处拒绝的是链中被带偏的后续跳
        if (hops === 0) throw new Error(`重定向目标非清华域: ${redactUrl(next)}`);
        throw new Error(`登录链重定向被引向校外地址,已中止(可能被篡改): ${redactUrl(next)}`);
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
  // 两个调用点(WebVPN OAuth 与 info 门户)表单都由 id 域提供,action 一律用
  // checkUrl;此处不再区分表单变体(此前的 formVariant 分支两处调用都传
  // 'thuinfo',是死代码,已删)
  async authenticateIdentity(formUrl, checkUrl, username, password, fingerPrint,
    twoFactorHandler, existingFormPage) {
    const formPage = existingFormPage ||
      await requestWithRedirects({ url: formUrl }, this.jar);
    const formBody = String(formPage.body || '');
    // 公钥在登录页上有两种已知形态,各由一条正则覆盖:
    //   ① JS 变量赋值:  var sm2publicKey = "04…";        (第二条正则)
    //   ② 标签文本内容: <span id="sm2publicKey">04…</span> (第一条正则)
    // 注意两条都**不支持** value= 属性形态(<input id="sm2publicKey" value="04…">):
    // 第一条的 ([^<]+) 抓的是标签闭合 > 之后的文本,拿不到属性值;第二条要求
    // sm2publicKey 后紧跟 : 或 =,而 " 与空格挡住了。学校若改用该形态会走
    // NO_PUBLIC_KEY(报"登录页可能已改版")——需要时再加一条属性分支,但仓库
    // 没有该形态的真实样本,不为未证实形态加路径。
    //
    // 抓到什么先不论,统一交给下面的形状校验:不能只判"抓到了非空内容"——
    // 标签写成 <input id="sm2publicKey">(无内容)时,([^<]+) 会捕获紧随其后的
    // 换行与缩进(truthy),通过旧守卫后 .trim() 得空串,doEncrypt(password, "")
    // 抛裸 TypeError("Cannot read properties of null (reading 'multiply')"),
    // 用户看到的是内部错误而不是"登录页可能已改版"(2026-09-21 实测)
    const rawMatch = /id=["']sm2publicKey["'][^>]*>([^<]+)</.exec(formBody) ||
      /sm2publicKey['"]?\s*[:=]\s*['"]([0-9a-fA-F]+)['"]/.exec(formBody);
    const candidate = rawMatch ? String(rawMatch[1]).trim() : '';
    // SEC1 未压缩点:130 个十六进制字符 = 04 前缀 + 64 字节 X/Y。
    // **必须要求 04 前缀**:sm2.doEncrypt 需要未压缩点格式,喂无前缀的 128 位
    // 会抛裸 TypeError("Cannot read properties of null (reading 'multiply')")。
    // 先前写成"可选 04 前缀"是凭猜测放宽(注释还写着"学校也可能给不带 04 的
    // 形态"),无任何证据,反而给同一个 TypeError 开了第二个入口——校验必须与
    // 库的实际要求一致(2026-09-22 审阅指出,实测复现)。压缩形态(66 字符)
    // 同样拒绝:需先解压才能加密,不在本函数职责内
    if (!/^04[0-9a-fA-F]{128}$/.test(candidate)) {
      throw AuthError('无法获取登录公钥,学校登录页可能已改版', 'NO_PUBLIC_KEY');
    }

    const formData = {
      i_user: username,
      // 04 前缀是 SEC1 未压缩点的标记字节,学校服务端据此解点;去掉则密码
      // 解密失败(现象是"密码不正确",看不出真正原因)
      i_pass: `04${sm2.doEncrypt(password, candidate)}`,
      fingerPrint: fingerPrint || '',
      fingerGenPrint: '',
      i_captcha: '',
    };
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
        const tf = await this.completeTwoFactor(fingerPrint, twoFactorHandler, approaches);
        body = tf.body;
        redirectUrl = isSuccessfulBody(body) ? firstAnchorUrl(body, tf.baseUrl) : '';
      }
    }

    if (!redirectUrl) {
      if (body.includes('出错了')) {
        throw AuthError('学校服务处理出错,请稍后重试', 'SERVER_ERROR');
      }
      // 响应体也要脱敏:学校把成功页改成 JS 跳转(1.9.1 记过的 2026-09-16
      // 那类改版)时取不到锚点,会落到这里,而带票的 body 前 80 字符会沿
      // message 进 watch 常驻控制台——脱敏不能只管 URL 那几个 throw 点
      throw AuthError(`登录失败(HTTP ${checkRes.statusCode},响应 ` +
        `${redactUrl(String(body || '').replace(/\s+/g, ' ')).slice(0, 80)}…)`,
        'LOGIN_FAILED');
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
    // 'null'/'true'/'123' 都是合法 JSON 但解析出来不是对象,下一行取属性会抛
    // 裸 TypeError,用户看到内部错误而不是这条明确文案(2026-09-22 实测)
    if (!json || typeof json !== 'object') {
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
    const maskPhone = p => String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
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
    // VERITY 是上游把 VERIFY 拼错了,原样照抄,勿"顺手修正"成 VERIFY_CODE
    // (改了现象是"验证码永远校验失败",极难归因)
    const verified = await this.requestAuthAction(
      { action: method === 'totp' ? 'VERITY_TOTP_CODE' : 'VERITY_CODE', vericode: code },
      '学校验证码校验失败');
    if (trustDevice) {
      try {
        const saved = await requestWithRedirects({
          url: ID_SAVE_FINGER(), method: 'POST',
          // deviceName 会出现在学校统一认证的"可信设备"列表里,是对外可见的
          // 名称;这个串是 1.6.x 去 dsh 品牌前的遗留(项目早期名),改动前先
          // 想清楚老设备条目
          data: { fingerprint: fingerPrint, deviceName: 'dsh-madmodel', radioVal: '是' },
        }, this.jar);
        const savedJson = JSON.parse(saved.body || '{}');
        // 同上:非对象时取 .result 会抛,而这里在 try 内,会被下面的 catch 报成
        // "可信设备登记失败",归因不准;显式判一下
        if (!savedJson || typeof savedJson !== 'object') {
          console.warn('学校未能登记可信设备:返回了无法识别的数据');
        } else if (savedJson.result !== 'success') {
          console.warn('学校未能登记可信设备:', savedJson.msg);
        }
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
    // 连 base 一起返回:调用方要拿成功页里的锚点,而锚点可能是相对路径,
    // 必须按**这一跳实际落地的 URL** 解析。此前调用方用固定的 id 域根作 base,
    // 锚点相对更深路径时会解析到错地址(2026-09-22 审阅指出)
    return { body: completed.body, baseUrl: completed.finalUrl || `${ID_PREFIX}/` };
  }

  // ===== WebVPN 会话 =====

  async attemptWebVpnLoginOnce(username, password, fingerPrint, twoFactorHandler) {
    this.jar.clearOrigins([ID_PREFIX, WEBVPN_PREFIX]);
    // 连发两次同一请求是刻意的,不是复制粘贴:第一跳只为走完 OAuth 的首次
    // 落 cookie/跳转建立表单会话,其响应内容弃用(第二跳才是判据);删掉第一行
    // 会让"首次启动"路径上 oauthNeedsLogin 判据拿到未建立的会话
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
        oauth);
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

  // 会话有效性判定。旧判据(2026-09-16 前生效):GET /login?oauth_login=true,
  // 已登录时最终页不含登录表单(sm2publicKey)。2026-09-16 学校 WebVPN 改版后
  // 该入口对任何状态(含已登录、带有效票)一律 302 到 id 登录表单,旧判据恒为
  // false——登录实际成功、票实际有效(隧道探测 200 实测),却被误报
  // "登录后未见会话",watch 续期从此卡死。
  // 新判据:带会话 cookie 探测 madmodel 隧道内地址(与 watch 保活探活、代理
  // 上游请求同一条路径——判定即真实业务可用性):3xx = 会话无效,2xx/4xx/5xx
  // = 穿过隧道到达应用即有效。网络错误保守判无效(与旧版 catch 行为一致)
  async verifyWebVpnSession() {
    // 按**隧道前缀**取 cookie,不是根路径:隧道会话 cookie 可能设在深路径
    // (Path=/https/<hash>)上,用根路径匹配会漏掉它,把有效会话误判成无效
    // (watch 续期据此卡死);按隧道前缀匹配同时也排除了 info 门户等**同域其他
    // 应用**的 cookie,避免把不相关的会话随请求带出去(2026-09-22)
    const verdict = await probeWebvpnSession(
      MADMODEL_TUNNEL_MODELS_URL,
      this.jar.headerFor(TUNNEL_COOKIE_SCOPE));
    return verdict === 'ok';
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
      formPage);
    if (!identity.redirectUrl) {
      throw AuthError('info 门户漫游未返回跳转地址', 'WEBVPN_INFO_ROAM_EMPTY');
    }
    const targetUrl = this.toLbRedirectUrl(identity.redirectUrl);
    // 打日志前剥掉 ticket/_csrf 等敏感查询参数(redactUrl——错误消息与日志
    // 同一规则,不能靠截断长度来"碰巧"截掉)
    console.warn('[WebVPN] info 漫游跟随', redactUrl(targetUrl).slice(0, 120));
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
  // 也可能直指原站。两种形态一律原样返回:ticket 取自在查询串(两种形态都
  // 带着它),入口请求发的就是这个 URL——前缀形态本就是本文件在用的隧道地址
  // 形态(见 INFO_PREFIX / MADMODEL_VPN_PREFIX),无需还原成原站主机名。
  //
  // 此前这里按 hex 解码 HASH,是错的:HASH = hex(IV) + hex(AES-128-CFB(主机名)),
  // 密钥与 IV 同为 ASCII 口令 "wrdvpnisthebest!",所以每串都以
  // 77726476706e69737468656265737421 开头——那正是口令本身的十六进制。按
  // UTF-8 读只能得出口令 + 密文乱码,还会连 path 与 ?ticket=... 一起丢掉
  // (门户实测不返回该形态,该分支从未执行)。编码方案与再生成命令可执行,
  // 见 test/tunnel-prefix.test.js
  mapRoamingUrl(url) {
    return decodeHTML(String(url || '')).replace(/&amp;/g, '&');
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
    // 无 roamingurl:门户会话缺失,强制重建后重试(实测验证的模式)。
    // 重建后必须重读 CSRF(1.9.0 前的缺陷:重建后 portalCsrf 仍为空,重试
    // 携带空 _csrf 注定失败);读不到则明确报错,不发明知缺凭据的请求
    const keys = json ? Object.keys(json).join(',') : '非JSON';
    console.warn(`[thuInfo] ${label}漫游无跳转地址,重建会话后重试(响应键=${keys})`);
    await this.establishWebVpnSession(
      credentials.username, credentials.password, credentials.fingerPrint,
      credentials.twoFactorHandler);
    this.portalCsrf = await this.readPortalCsrf();
    if (!this.portalCsrf) {
      throw AuthError(label + '会话重建后未取得 CSRF token', 'THUINFO_CSRF_EMPTY');
    }
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
      // WebVPN 隧道会话 cookie:上游走 WebVPN 前缀时必须随请求回传(不带会被
      // 隧道踢回登录页)。认证链结束时 jar 里 webvpn 域的 cookie 即所需全集,
      // 与 token 同生命周期(每次续期整链重跑,cookie 随之更新)。
      // 按**隧道前缀**取:上游打在隧道的深路径上,cookie 可能设在
      // Path=/https/<hash> 这种深路径,用根路径匹配会漏掉它;按隧道前缀匹配
      // 同时排除同域其他应用(如 info 门户)的 cookie——上游只该拿到隧道的
      cookie: this.jar.headerFor(TUNNEL_COOKIE_SCOPE),
    };
  }
}

// 探活 HTTP 状态码 → verdict 的纯判定(独立导出便于离线测试;网络层错误由
// 调用方在 catch 里归为 'network',本函数只判 HTTP 状态)。隧道对未认证
// 会话的固定形态是 3xx 跳登录页(实测 302 → /login);2xx 说明会话有效;
// 4xx/5xx 也意味着请求已穿过隧道到达应用(会话有效,失败在应用侧)。
function classifyProbeStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'invalid';
  return 'ok';
}

// WebVPN 隧道会话探活:带 cookie GET 一个隧道内地址。请求本身重置隧道空闲
// 计时;返回 verdict 供 watch 区分"会话失效要重签凭据"与"网络抖动不动凭据"。
async function probeWebvpnSession(url, cookie) {
  try {
    const res = await fetch(url, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(15e3),
    });
    try { res.body?.cancel(); } catch (e) { /* 已结束的 body 重复取消 */ }
    return classifyProbeStatus(res.status);
  } catch (e) {
    return 'network';
  }
}

module.exports = {
  MadmodelAuthClient,
  CookieJar,
  jwtExpiresAt,
  generateFingerprint,
  AuthError,
  requestWithRedirects,
  classifyProbeStatus,
  probeWebvpnSession,
  // madmodel 应用的 WebVPN 隧道前缀:config.js 据此拼默认上游、判隧道形态与
  // cookie 回传——单一来源,防止复制串漂移导致"上游是隧道但保活/cookie 判定
  // 失效"的静默错位
  MADMODEL_VPN_PREFIX,
  TUNNEL_COOKIE_SCOPE,
  // info 门户的隧道前缀:HASH 的编码方案与再生成命令见 test/tunnel-prefix.test.js
  INFO_PREFIX,
  // 隧道内 models 探测地址(登录期会话判定与保活共用,见常量定义处注释)
  MADMODEL_TUNNEL_MODELS_URL,
  // 以下为认证链中出错概率最高的纯判定函数(响应体解码/URL 解析/重定向白名单)。
  // 认证链无法端到端离线验证,单独导出便于本地复现与审查
  decodeBody,
  resolveUrl,
  isAllowedRedirect,
  // 展示用脱敏(纯函数,测试钉住三类参数的大小写不敏感匹配与"其余参数保留")
  redactUrl,
};

