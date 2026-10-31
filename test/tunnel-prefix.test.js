// test/tunnel-prefix.test.js — WebVPN 隧道前缀的编码方案与 mapRoamingUrl 的直通语义。
//
// 编码:hex(IV) + hex(AES-128-CFB(主机名)),密钥与 IV 同为 ASCII 口令
// "wrdvpnisthebest!"(深信服 wengine 的固定常量,公开实现里通用)。
// 学校换 madmodel 主机名时:按下面的 derive() 生成新串,替换 core/auth-shared.js 里
// 的 MADMODEL_VPN_PREFIX / INFO_PREFIX。
//
// 为什么要钉住:mapRoamingUrl 曾把 HASH 当 UTF-8 解码(得出口令 + 密文乱码),
// 并把 path 与 ?ticket=... 一起丢掉——真触发时表现为"漫游未返回 ticket",
// 且看不出原因。前缀形态即便出现,只要原样透传,ticket 就不会丢。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { MadmodelAuthClient, CookieJar, MADMODEL_VPN_PREFIX, INFO_PREFIX } = require('../madmodel-auth');

const KEY = Buffer.from('wrdvpnisthebest!', 'utf8');
function derive(host) {
  const cipher = crypto.createCipheriv('aes-128-cfb', KEY, KEY);
  return KEY.toString('hex') + cipher.update(host, 'utf8').toString('hex');
}

test('隧道前缀 HASH = hex(口令) + hex(AES-128-CFB(主机名))', () => {
  assert.strictEqual(
    MADMODEL_VPN_PREFIX,
    `https://webvpn.tsinghua.edu.cn/https/${derive('madmodel.cs.tsinghua.edu.cn')}`);
  // info 门户前缀同源同法,两个常量各自 load-bearing:只查"都以口令开头"
  // 挡不住把两个主机名写反
  assert.strictEqual(
    INFO_PREFIX,
    `https://webvpn.tsinghua.edu.cn/https/${derive('info.tsinghua.edu.cn')}`);
});

test('源码里的每个隧道 HASH 都以口令的十六进制开头', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'auth-shared.js'), 'utf8');
  const hashes = [...source.matchAll(/\/https\/([0-9a-f]{64,})/g)].map(m => m[1]);
  assert.ok(hashes.length >= 2, `源码里没扫到隧道 HASH(实际 ${hashes.length} 个)`);
  for (const hash of hashes) {
    assert.ok(hash.startsWith(KEY.toString('hex')),
      `HASH 前缀不是口令的十六进制: ${hash.slice(0, 32)}…`);
  }
});

test('mapRoamingUrl 原样透传两种形态,ticket 不丢', () => {
  const client = new MadmodelAuthClient(new CookieJar());
  const plain = 'https://info.tsinghua.edu.cn/b/yyfw/vyyfwxx/info/portal_fg/common/onlineAppRedirect?ticket=ABC123';
  assert.strictEqual(client.mapRoamingUrl(plain), plain);

  const prefixed = `https://webvpn.tsinghua.edu.cn/https/${derive('info.tsinghua.edu.cn')}` +
    '/b/yyfw/vyyfwxx/info/portal_fg/common/onlineAppRedirect?ticket=ABC123';
  assert.strictEqual(client.mapRoamingUrl(prefixed), prefixed, '前缀形态被改写了');
  const m = /[?&]ticket=([^&#]+)/.exec(client.mapRoamingUrl(prefixed));
  assert.ok(m && m[1] === 'ABC123', '前缀形态下 ticket 取不到');
});

test('mapRoamingUrl 还原 HTML 实体(&amp; 不能截断查询串)', () => {
  const client = new MadmodelAuthClient(new CookieJar());
  assert.strictEqual(client.mapRoamingUrl('https://a/b?ticket=X&amp;y=2'),
    'https://a/b?ticket=X&y=2');
});
