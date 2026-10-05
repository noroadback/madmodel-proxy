'use strict';

const { localBaseUrl } = require('./listen-config');

async function isProxyRunning(port, fetchImpl = fetch, host = '127.0.0.1') {
  try {
    const base = localBaseUrl({ host, port });
    const options = { signal: AbortSignal.timeout(2000), redirect: 'error' };
    let response = await fetchImpl(`${base}/healthz`, options);
    // 旧版没有 healthz；新代码仍能识别尚未重启的旧代理。
    if (response.status === 404) {
      await response.body?.cancel();
      response = await fetchImpl(`${base}/`, options);
    }
    const body = await response.json();
    return response.status === 200 && body?.proxy === 'madmodel';
  } catch { return false; }
}

module.exports = { isProxyRunning };

if (require.main === module) {
  const config = require('../config');
  isProxyRunning(config.port, undefined, config.host).then(up => { process.exitCode = up ? 0 : 1; });
}
