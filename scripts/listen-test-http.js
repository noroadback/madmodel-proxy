'use strict';

// Windows 自定义动态端口范围可能包含 fetch 禁止访问的端口。
// 仅测试夹具使用：在未接受连接时重新选端口，不改变生产监听配置。
const blockedPorts = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

async function listenTestHttp(server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', ready); reject(error); };
      const ready = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(0, '127.0.0.1');
    });
    const port = server.address().port;
    if (port >= 1024 && !blockedPorts.has(port)) return port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('无法为 HTTP 测试分配 fetch 可访问的端口');
}

module.exports = { listenTestHttp };
