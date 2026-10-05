'use strict';

const { isIP } = require('node:net');

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

// 启动入口和 HTTP 工厂共用检查，直接运行 proxy.js 也不能绕过。
function validateListenConfig(config) {
  const host = config.host ?? '127.0.0.1';
  if (host !== 'localhost' && !isIP(host)) {
    throw new Error('PROXY_BIND_HOST 必须是 IP 地址或 localhost。');
  }
  const apiKeys = config.apiKeys || [];
  if (!Array.isArray(apiKeys) || apiKeys.some(key => typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key))) {
    throw new Error('PROXY_API_KEYS 请使用英文字母、数字或符号，不要包含空格；多个密钥用逗号分隔。');
  }
  const loopbackOnly = isLoopbackHost(host);
  if (!loopbackOnly && !apiKeys.length) {
    throw new Error('局域网监听必须设置 PROXY_API_KEYS；仅本机使用请设置 PROXY_BIND_HOST=127.0.0.1。');
  }
  return { host, apiKeys, loopbackOnly };
}

// 通配监听地址不能作为客户端连接地址；IPv6 URL 必须带方括号。
function localBaseUrl({ host = '127.0.0.1', port }) {
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

module.exports = { validateListenConfig, localBaseUrl };
