'use strict';

// Windows 环境变量名不区分大小写；复制出来的普通对象也保持同样的读取行为。
function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function supportsColor({ env = process.env, isTTY = process.stdout.isTTY } = {}) {
  const noColor = envValue(env, 'NO_COLOR');
  if (noColor !== undefined && String(noColor) !== '') return false;
  const forceColor = envValue(env, 'FORCE_COLOR');
  if (forceColor !== undefined) {
    if (String(forceColor) === '0') return false;
    if (['', '1', '2', '3'].includes(String(forceColor))) return true;
  }
  const proxyColor = envValue(env, 'PROXY_LOG_COLOR');
  if (String(proxyColor) === '0') return false;
  if (String(proxyColor) === '1') return true;
  return Boolean(isTTY) && envValue(env, 'TERM') !== 'dumb';
}

function colorFirstOutput(text, firstMs, options) {
  if (!Number.isFinite(firstMs) || firstMs < 0 || !supportsColor(options)) return text;
  const color = firstMs < 5000 ? 32 : firstMs < 10000 ? 33 : 31;
  return `\x1b[${color}m${text}\x1b[0m`;
}

function childColorEnv({ env = process.env, isTTY = process.stdout.isTTY } = {}) {
  const childEnv = { ...env };
  // 只传播代理日志的颜色选择，不用 FORCE_COLOR 改变子进程的其他 console 格式。
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'PROXY_LOG_COLOR') delete childEnv[key];
  }
  childEnv.PROXY_LOG_COLOR = supportsColor({ env, isTTY }) ? '1' : '0';
  return childEnv;
}

module.exports = { supportsColor, colorFirstOutput, childColorEnv };
