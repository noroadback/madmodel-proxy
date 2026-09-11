// core/update-check.js
// 启动时的新版本检查:匿名 GET GitHub releases/latest,比对 tag 与本地版本。
// 请求不带任何凭据(无 token/密码/用户标识);失败(断网/GitHub 不可达/限流/
// 响应畸形)一律静默——检查是锦上添花,永远不打扰启动。
// isNewerVersion 为纯函数单独导出,测试钉死比较语义(数值比较,1.10.0 > 1.9.0)。
'use strict';

// latestTag(如 "v1.8.0")是否比 current(如 "1.7.2")新。
// 只认 vX.Y.Z / X.Y.Z 开头的三元组;畸形(缺段/非数字)按"不新"处理——宁可
// 漏报不误报,畸形 tag 不该触发升级提示。无行尾锚点是有意的:v1.8.0-beta
// 之类带后缀的 tag 也按 1.8.0 参与比较(后缀不参与高低判定)
function isNewerVersion(current, latestTag) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(current);
  const b = parse(latestTag);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

// 检查 repo(如 "noroadback/madmodel-proxy")的最新 release。
// 返回 'latest'(已是最新)| { update: 'vX.Y.Z' } | null(检查失败,调用方静默)。
// fetchImpl 可注入,测试离线化
async function checkForUpdate(repo, currentVersion, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null; // 403 限流/404 无 release 等
    const j = await res.json();
    const tag = j && typeof j.tag_name === 'string' ? j.tag_name.trim() : '';
    if (!tag) return null;
    return isNewerVersion(currentVersion, tag) ? { update: tag } : 'latest';
  } catch (e) {
    return null; // 断网/超时/响应体非 JSON:静默
  }
}

module.exports = { isNewerVersion, checkForUpdate };
