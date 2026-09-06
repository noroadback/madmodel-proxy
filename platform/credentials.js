// platform/credentials.js
// 凭据与 token 存取的平台分发点。core/service 层只依赖这里的接口:
//   credentials.readToken() / writeToken(token, expiresAt)
//   credentials.readAccount() / writeAccount(user, pass, fingerprint) / hasAccount()
// 完整功能当前只支持 Windows(DPAPI);非 Windows 抛出明确错误而不是静默
// 降级为明文存储——不做不成熟的跨平台明文回退。

'use strict';

if (process.platform !== 'win32') {
  module.exports = {
    readToken() { throw new Error('凭据存储依赖 Windows DPAPI,当前平台不支持(完整功能仅 Windows)'); },
    writeToken() { throw new Error('凭据存储依赖 Windows DPAPI,当前平台不支持(完整功能仅 Windows)'); },
    readAccount() { throw new Error('凭据存储依赖 Windows DPAPI,当前平台不支持(完整功能仅 Windows)'); },
    writeAccount() { throw new Error('凭据存储依赖 Windows DPAPI,当前平台不支持(完整功能仅 Windows)'); },
    hasAccount() { return false; },
  };
} else {
  module.exports = require('./windows/credentials');
}
