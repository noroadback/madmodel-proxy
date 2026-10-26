// test/auth-url-redaction.test.js — 认证链错误消息的 ticket 脱敏回归。
//
// 三个 throw 点(requestWithRedirects 的 :281 初始校验与 :330/:331 重定向拒绝)
// 会把完整 URL 打进 message,而认证链的重定向本来就靠 ticket 串联——next 携票
// 是常态,这些 message 的去向是 scheduler.logError 的常驻控制台。
// 钉三件事:① 三种敏感参数(ticket/_csrf/oauth_token)的值不进 message;
// ② 非敏感参数照旧保留(排障需要);③ 实际发给 fetch 的 URL 保持原样
// ——redactUrl 只处理展示文本,改了请求就断链。
// fetch 全程 mock,不访问学校服务。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');

const { CookieJar, requestWithRedirects, redactUrl, MadmodelAuthClient } = require('../madmodel-auth');

const FORM = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/xxx/0';
const CHECK = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check';

const SECRET_TICKET = 'SUPERSECRET-TICKET-9f8e7d';
const SECRET_CSRF = 'CSRF-SECRET-12345';
const SECRET_OAUTH = 'OAUTH-TOKEN-SECRET';

// mock fetch:记录收到的请求 URL,按脚本回 302/200
function withFetchMock(script, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(String(url));
    const r = script(String(url), opts) || { status: 200 };
    const headers = {};
    if (r.status >= 300 && r.status < 400 && r.location) headers.location = r.location;
    return new Response(r.body || '', { status: r.status, headers });
  };
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = original; });
}

test('初始请求 URL 不在清华域:三敏感参数脱敏,其余保留', async () => {
  const url = `https://evil.example.com/login?ticket=${SECRET_TICKET}` +
    `&_csrf=${SECRET_CSRF}&oauth_token=${SECRET_OAUTH}&lang=zh`;
  await assert.rejects(
    () => requestWithRedirects({ url }, new CookieJar()),
    (e) => {
      assert.ok(!e.message.includes(SECRET_TICKET), 'ticket 原文进了错误消息: ' + e.message);
      assert.ok(!e.message.includes(SECRET_CSRF), '_csrf 原文进了错误消息');
      assert.ok(!e.message.includes(SECRET_OAUTH), 'oauth_token 原文进了错误消息');
      assert.ok(e.message.includes('ticket=***'), '缺少 ticket=***: ' + e.message);
      assert.ok(e.message.includes('_csrf=***'), '缺少 _csrf=***');
      assert.ok(e.message.includes('oauth_token=***'), '缺少 oauth_token=***');
      assert.ok(e.message.includes('lang=zh'), '非敏感参数被误删: ' + e.message);
      return true;
    });
});

test('首跳重定向目标非清华域:错误消息脱敏', async () => {
  await withFetchMock(() => ({
    status: 302,
    location: `https://evil.example.com/next?ticket=${SECRET_TICKET}&step=2`,
  }), async () => {
    await assert.rejects(
      () => requestWithRedirects(
        { url: 'https://id.tsinghua.edu.cn/start' }, new CookieJar(), 12),
      (e) => {
        assert.ok(e.message.startsWith('重定向目标非清华域: '), '意外形态: ' + e.message);
        assert.ok(!e.message.includes(SECRET_TICKET), 'ticket 原文进了错误消息: ' + e.message);
        assert.ok(e.message.includes('ticket=***'), '缺少 ticket=***: ' + e.message);
        assert.ok(e.message.includes('step=2'), '非敏感参数被误删');
        return true;
      });
  });
});

test('后续跳转被引向校外地址(可能被篡改):错误消息脱敏', async () => {
  let hops = 0;
  await withFetchMock(() => {
    hops += 1;
    return hops === 1
      ? { status: 302, location: 'https://id.tsinghua.edu.cn/step1?x=1' }
      : { status: 302, location: `https://evil.example.com/deep?ticket=${SECRET_TICKET}` };
  }, async () => {
    await assert.rejects(
      () => requestWithRedirects(
        { url: 'https://id.tsinghua.edu.cn/start' }, new CookieJar(), 12),
      (e) => {
        assert.ok(e.message.includes('登录链重定向被引向校外地址'), '意外形态: ' + e.message);
        assert.ok(!e.message.includes(SECRET_TICKET), 'ticket 原文进了错误消息: ' + e.message);
        assert.ok(e.message.includes('ticket=***'), '缺少 ticket=***: ' + e.message);
        return true;
      });
  });
});

test('合法链路:实际请求 URL 不被脱敏(展示层与请求层分离)', async () => {
  // 第一跳带 ticket 的校内跳转是认证链常态,必须原样跟随;第二跳收 200 终止
  let hop = 0;
  await withFetchMock(() => {
    hop += 1;
    return hop === 1
      ? { status: 302, location: `https://id.tsinghua.edu.cn/ok?ticket=${SECRET_TICKET}` }
      : { status: 200, body: 'ok' };
  }, async (seen) => {
    const r = await requestWithRedirects(
      { url: 'https://id.tsinghua.edu.cn/start' }, new CookieJar(), 12);
    assert.strictEqual(r.statusCode, 200);
    const followed = seen[1];
    assert.ok(followed.includes(`ticket=${SECRET_TICKET}`),
      '发给 fetch 的 URL 丢了 ticket——redactUrl 泄漏进了请求层: ' + followed);
  });
});

test('redactUrl 纯函数:大小写不敏感 + 空值安全', () => {
  assert.strictEqual(
    redactUrl('https://a.tsinghua.edu.cn/p?Ticket=UP&x=1'),
    'https://a.tsinghua.edu.cn/p?Ticket=***&x=1');
  assert.strictEqual(redactUrl(''), '');
  assert.strictEqual(redactUrl(null), '');
  assert.strictEqual(redactUrl(undefined), '');
  // 片段(#)后的内容不被当查询参数处理;# 前的照常脱敏
  assert.strictEqual(
    redactUrl('https://a.tsinghua.edu.cn/p?ticket=SH#frag'),
    'https://a.tsinghua.edu.cn/p?ticket=***#frag');
});

test('redactUrl 用于 HTML 片段:不贪婪吞掉引号与闭合标签', () => {
  // 学校把成功页改成 JS 跳转时,错误消息里带的是 HTML 片段而非纯 URL。
  // 旧字符类 [^&#]* 会一路吃到引号与 </script>,把排障需要的上下文抹掉
  const frag = '<script>location.replace("/f/info/x?ticket=' + SECRET_TICKET + '")</script>';
  const out = redactUrl(frag);
  assert.ok(!out.includes(SECRET_TICKET), 'ticket 原文未脱敏: ' + out);
  assert.ok(out.includes('ticket=***'), '缺少 ticket=***: ' + out);
  assert.ok(out.includes('")</script>'), '引号与闭合标签被贪婪吃掉: ' + out);
});

test('LOGIN_FAILED:响应体里的 ticket 不进错误消息(JS 跳转形态)', async () => {
  // 无 <a href> 锚点 → redirectUrl 为空 → 落到 LOGIN_FAILED,把 body 前 80
  // 字符打进 message,而该 message 的去向是 watch 常驻控制台
  const sm2 = require('../sm2.js');
  const { publicKey } = sm2.generateKeyPairHex();
  const formPage = '<html><script>var sm2publicKey = "' + publicKey + '";</script></html>';
  const checkBody = '<script>location.replace("/f/info/x?ticket=' + SECRET_TICKET + '")</script>';
  await withFetchMock((url) => {
    if (String(url).includes('/form/')) return { status: 200, body: formPage };
    return { status: 200, body: checkBody };
  }, async () => {
    const client = new MadmodelAuthClient(new CookieJar());
    await assert.rejects(
      () => client.authenticateIdentity(FORM, CHECK, 'u', 'p', 'fp'),
      (e) => {
        assert.strictEqual(e.code, 'LOGIN_FAILED', '意外形态: ' + e.message);
        assert.ok(!e.message.includes(SECRET_TICKET),
          '响应体里的 ticket 原文进了错误消息: ' + e.message);
        return true;
      });
  });
});

test('redactUrl 带引号的值也要整体脱敏', () => {
  // 收紧字符类时若只排除引号而不单独处理"带引号的值",引号后的内容会继续
  // 泄漏——而响应体(JSON/JS 片段)里带引号是常态(2026-09-21 审阅指出)
  const out1 = redactUrl('redirect to ?ticket="' + SECRET_TICKET + '" now');
  assert.ok(!out1.includes(SECRET_TICKET), '双引号值未脱敏: ' + out1);
  assert.ok(out1.includes('ticket=***'), '缺少 ticket=***: ' + out1);

  const out2 = redactUrl("?ticket='" + SECRET_TICKET + "'&next=2");
  assert.ok(!out2.includes(SECRET_TICKET), '单引号值未脱敏: ' + out2);
  assert.ok(out2.includes('next=2'), '非敏感参数被误删: ' + out2);

  // 引号内含 & 的值也要整体吃掉,不能半途停下
  const out3 = redactUrl('?ticket="' + SECRET_TICKET + '&x=1"');
  assert.ok(!out3.includes(SECRET_TICKET), '带 & 的引号值未整体脱敏: ' + out3);

  // 裸值(无引号)行为不变
  assert.strictEqual(
    redactUrl('https://a/b?ticket=' + SECRET_TICKET + '&x=1'),
    'https://a/b?ticket=***&x=1');
});

test('HTML &amp; 分隔符:后续敏感参数同样脱敏', () => {
  // 响应体是 HTML 时,其中的 URL 通常把 & 转义成 &amp; ;只认裸 & 会让
  // 第二个及以后的敏感参数完全不脱敏(2026-09-22 审阅指出)
  const out = redactUrl('?ticket=PUBLIC&amp;_csrf=' + SECRET_CSRF +
    '&amp;oauth_token=' + SECRET_OAUTH);
  assert.ok(!out.includes(SECRET_CSRF), '_csrf 经 &amp; 分隔后未脱敏: ' + out);
  assert.ok(!out.includes(SECRET_OAUTH), 'oauth_token 经 &amp; 分隔后未脱敏: ' + out);
  assert.ok(out.includes('ticket=***'), '缺少 ticket=***');
  // 分隔符原样保留(HTML 里换成裸 & 会破坏文档)
  assert.ok(out.includes('&amp;'), '&amp; 分隔符被改动: ' + out);
  // 裸 & 行为不变
  assert.strictEqual(redactUrl('?ticket=A&_csrf=B'), '?ticket=***&_csrf=***');
});

// HTML 属性值里带引号时,规范写法是把引号转义成实体(&quot; / &#34; / &#39;)。
// 只认裸引号会让实体包裹的值整段留下:ticket= 脱了,值还在消息里
// (2026-09-24 实测三种实体均泄漏)。这一形态正是 LOGIN_FAILED 把响应体
// 前 80 字符打进 watch 常驻控制台时可出现的形态
test('HTML 实体引号包裹的值:同样整体脱敏', () => {
  const entities = [
    ['&quot;', '&quot;'],
    ['&#34;', '&#34;'],
    ['&#39;', '&#39;'],
    ['&apos;', '&apos;'],
  ];
  for (const [open, close] of entities) {
    const out = redactUrl('<a href="/x?ticket=' + open + SECRET_TICKET + close + '">l</a>');
    assert.ok(!out.includes(SECRET_TICKET),
      '实体 ' + open + ' 包裹的 ticket 未脱敏: ' + out);
    assert.ok(out.includes('ticket=***'), '实体 ' + open + ' 缺 ticket=***: ' + out);
    // HTML 结构不被吞:闭合标签与引号都还在
    assert.ok(out.includes('">l</a>'), '实体 ' + open + ' 的 HTML 结构被贪婪吃掉: ' + out);
  }
  // 数字实体的前导零写法(&#034;)也是合法形态,不得漏
  const padded = redactUrl('<a href="/x?ticket=&#034;' + SECRET_TICKET + '&#034;">');
  assert.ok(!padded.includes(SECRET_TICKET), '前导零实体形态未脱敏: ' + padded);
});

test('HTML 实体引号:多参数与各敏感参数名都覆盖', () => {
  const out = redactUrl('?ticket=&quot;' + SECRET_TICKET + '&quot;&amp;_csrf=&quot;' +
    SECRET_CSRF + '&quot;&amp;oauth_token=&quot;' + SECRET_OAUTH + '&quot;');
  assert.ok(!out.includes(SECRET_TICKET), 'ticket 泄漏: ' + out);
  assert.ok(!out.includes(SECRET_CSRF), '_csrf 泄漏: ' + out);
  assert.ok(!out.includes(SECRET_OAUTH), 'oauth_token 泄漏: ' + out);
  // 实体分隔符原样保留(换成裸 & 会破坏 HTML)
  assert.ok(out.includes('&amp;'), '&amp; 分隔符被改动: ' + out);
  // 裸引号与纯 URL 行为不回归
  assert.strictEqual(redactUrl('?ticket="S"'), '?ticket=***');
  assert.strictEqual(redactUrl('https://a/b?ticket=S&x=1'), 'https://a/b?ticket=***&x=1');
});

// 实体分支的值类若不排空白,值里带空格的形态会重新泄漏。这条路径实测可达:
// LOGIN_FAILED 先做 \s+ → ' ' 归一化再脱敏(madmodel-auth.js:512),属性值里的
// 换行恰好被归一成空格。故实体值的字符类只排 & < > 与换行,不排空格
test('实体引号内的值含空白:仍整体脱敏(LOGIN_FAILED 归一化路径可达)', () => {
  const ws = [' ', '\t', '\u00a0', '  '];
  for (const gap of ws) {
    const out = redactUrl('?ticket=&quot;tk' + gap + SECRET_TICKET + '&quot;');
    assert.ok(!out.includes(SECRET_TICKET),
      '实体值内含 ' + JSON.stringify(gap) + ' 时票据泄漏: ' + out);
    assert.ok(out.includes('ticket=***'), '缺 ticket=***: ' + out);
  }
  // 走一遍 LOGIN_FAILED 的真实处理链(归一化空白 → 脱敏),复现可达性
  const body = '<a href="/f/x?ticket=&quot;tk ' + SECRET_TICKET + '&quot;">go</a>';
  const msg = redactUrl(String(body).replace(/\s+/g, ' '));
  assert.ok(!msg.includes(SECRET_TICKET), 'LOGIN_FAILED 链路上票据泄漏: ' + msg);
});

// 十六进制实体(&#x22; / &#x27;)与十进制是同级规范写法,只认十进制等于覆盖不全
test('十六进制实体引号:同样脱敏', () => {
  for (const [open, close] of [['&#x22;', '&#x22;'], ['&#X22;', '&#X22;'], ['&#x27;', '&#x27;']]) {
    const out = redactUrl('<a href="/x?ticket=' + open + SECRET_TICKET + close + '">l</a>');
    assert.ok(!out.includes(SECRET_TICKET),
      '十六进制实体 ' + open + ' 未脱敏: ' + out);
    assert.ok(out.includes('ticket=***'), '缺 ticket=***: ' + out);
  }
});

// 实体分支放宽值类后不得变得贪婪:HTML 结构、后续参数、闭合标记都要保住
test('实体分支不贪婪:结构、后续参数、闭合标记均保留', () => {
  const a = redactUrl('<a href="/x?ticket=&quot;' + SECRET_TICKET + '&quot;">l</a> 后续');
  assert.ok(a.includes('">l</a> 后续'), 'HTML 结构被吞: ' + a);
  const b = redactUrl('?ticket=&quot;' + SECRET_TICKET + '&quot;&amp;_csrf=' + SECRET_CSRF);
  assert.ok(!b.includes(SECRET_CSRF), '后续参数未脱敏(实体分支吃掉了 &amp;): ' + b);
  assert.ok(b.includes('&amp;'), '&amp; 分隔符被改动: ' + b);
  // 裸值形态的空白排除保持不变(没有闭合标记兜底,放宽会吞后续)
  assert.strictEqual(redactUrl('?ticket=A&x=1'), '?ticket=***&x=1');
});

test('认证重定向被拒绝或超过跳数时也取消响应体', async t => {
  for (const scenario of [
    { name: '校外目标', target: 'https://outside.example/next', limit: 16 },
    { name: '跳数超限', target: 'https://id.tsinghua.edu.cn/next', limit: 0 },
    { name: '非法地址', target: 'http://[', limit: 16 },
  ]) {
    await t.test(scenario.name, async t => {
      let cancelled = 0, requests = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(Buffer.from('unused redirect body')); },
          cancel() { cancelled++; },
        }), { status: 302, headers: { location: scenario.target } });
      });
      await assert.rejects(() => requestWithRedirects(
        { url: 'https://id.tsinghua.edu.cn/start' }, new CookieJar(), scenario.limit));
      assert.strictEqual(requests, 1, '失败目标不能被跟随');
      assert.strictEqual(cancelled, 1, '失败出口必须取消未读取的响应体');
    });
  }
});
