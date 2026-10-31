'use strict';
// 在配置加载时编译；纯请求归一化只使用调用方提供的规则快照。
function compileToolStripRules(raw = 'DeepSeek-R1-W8A8') {
  const patterns = [];
  let start = 0, inRegex = false, inClass = false, escaped = false;
  const invalid = () => Object.assign(new Error('PROXY_STRIP_TOOLS_FOR 含未闭合或无效的正则规则，请检查配置。'), { code: 'INVALID_TOOL_RULE' });
  for (let i = 0; i <= raw.length; i++) {
    const c = raw[i];
    if (i === raw.length || (c === ',' && !inRegex)) {
      if (inRegex) throw invalid();
      const pattern = raw.slice(start, i).trim();
      if (pattern) {
        try {
          if (pattern.startsWith('/')) {
            const end = pattern.lastIndexOf('/');
            if (end < 1) throw invalid();
            patterns.push(new RegExp(pattern.slice(1, end), pattern.slice(end + 1)));
          } else {
            const source = pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
            patterns.push(new RegExp('^' + source + '$', 'i'));
          }
        } catch { throw invalid(); }
      }
      start = i + 1;
      inRegex = inClass = escaped = false;
      continue;
    }
    if (i === start && /\s/.test(c)) { start++; continue; }
    if (i === start && c === '/') { inRegex = true; continue; }
    if (!inRegex) continue;
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) inRegex = false;
  }
  return Object.freeze(patterns);
}
const DEFAULT_TOOL_STRIP_RULES = compileToolStripRules();
function shouldStripTools(model, rules = DEFAULT_TOOL_STRIP_RULES) {
  return typeof model === 'string' && rules.some(pattern => {
    pattern.lastIndex = 0; // g/y 规则也必须逐请求保持一致。
    return pattern.test(model);
  });
}
module.exports = { compileToolStripRules, shouldStripTools, DEFAULT_TOOL_STRIP_RULES };
