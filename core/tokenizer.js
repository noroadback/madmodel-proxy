// core/tokenizer.js
// DeepSeek 分词器的本地精确计 token(纯逻辑)。2026-09-10 实测确认学校
// madmodel 的 DeepSeek-V4-Flash-0731 沿用 DeepSeek-V3 公开分词器
// (HuggingFace,MIT,vendor/deepseek-tokenizer.json):本地计数与上游
// usage.prompt_tokens 在 24 万 token 级 payload 上逐个吻合,差异仅为
// chat 模板固定开销(下方 countPromptTokens 内校准)。
// 上游据此分词校验 prompt+max_tokens ≤ 262,144(core/proxy-service.js
// 预检门),本模块让预检从估算变为精确。
// 算法:byte-level BPE——三段 pre-tokenizer(数字 1-3 位/CJK 段/GPT-2 式
// 主正则)切 piece,每 piece 按 merges 优先级贪心合并,查词表计数。
// 两级缓存:piece 级(BPE 结果)与文本级(整段 content),增量会话里
// 旧消息全部命中缓存,只有新增内容真正参与计算。

'use strict';

const fs = require('fs');
const path = require('path');

// ---- byte-level 字母表(GPT-2 同构):可打印 ASCII + ¡-¬ + ®-ÿ 原样,其余字节映射到 256+ ----
function buildByteToUni() {
  const map = new Map();
  for (let i = 33; i <= 126; i++) map.set(i, String.fromCharCode(i));
  for (let i = 161; i <= 172; i++) map.set(i, String.fromCharCode(i));
  for (let i = 174; i <= 255; i++) map.set(i, String.fromCharCode(i));
  let n = 256;
  for (let b = 0; b < 256; b++) if (!map.has(b)) map.set(b, String.fromCharCode(n++));
  return map;
}

// 两级缓存的内存边界(长驻进程,缓存必须封顶,否则任意流量下慢速泄漏):
// piece 级按条目数封顶(piece 是短串,条目数即内存量级);文本级按 key 的
// 字符总量封顶——它钉住的是整条消息字符串,大消息会话下按条目数封顶
// 挡不住体积,按字符预算逐出才能压住。均 FIFO(Map 保持插入序)
const PIECE_CACHE_LIMIT = 65536;
const TEXT_CACHE_CHARS = 8 * 1024 * 1024;

function createTokenizer(model) {
  const byteToUni = buildByteToUni();
  const mergeRank = new Map(); // "a b"(byte-level 字符对) -> 合并优先级
  model.model.merges.forEach((m, i) => mergeRank.set(m, i));
  const vocab = new Set(Object.keys(model.model.vocab));
  const addedTokens = new Set((model.added_tokens || []).map(t => t.content));

  // 正则字面量带 g 标志有 lastIndex 状态,splitIsolated 每次复位;不可复用同一个正则对象跨调用
  const RE_DIGIT = () => /\p{N}{1,3}/gu;
  const RE_CJK = () => /[一-龥぀-ゟ゠-ヿ]+/gu;
  const RE_MAIN = () => /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

  // Isolated 切分:匹配段与非匹配段交替成为独立 piece(HF tokenizers Split 行为)
  function splitIsolated(text, makeRe) {
    const re = makeRe();
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const pieceCache = new Map(); // piece(byte-level 映射后) -> token 数
  function bpeCount(piece) {
    let c = pieceCache.get(piece);
    if (c !== undefined) return c;
    let parts = Array.from(piece);
    while (parts.length >= 2) {
      let bestRank = Infinity, bestIdx = -1;
      for (let i = 0; i + 1 < parts.length; i++) {
        const r = mergeRank.get(parts[i] + ' ' + parts[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
    }
    c = parts.filter(p => vocab.has(p)).length;
    if (pieceCache.size >= PIECE_CACHE_LIMIT) {
      pieceCache.delete(pieceCache.keys().next().value);
    }
    pieceCache.set(piece, c);
    return c;
  }

  const textCache = new Map(); // 原始文本 -> token 数
  let textCacheChars = 0; // 已缓存 key 的字符总量(逐出依据)
  function countText(text) {
    if (typeof text !== 'string' || text === '') return 0;
    let c = textCache.get(text);
    if (c !== undefined) return c;
    let pieces = [text];
    pieces = pieces.flatMap(p => splitIsolated(p, RE_DIGIT));
    pieces = pieces.flatMap(p => splitIsolated(p, RE_CJK));
    pieces = pieces.flatMap(p => splitIsolated(p, RE_MAIN));
    c = 0;
    for (const p of pieces) {
      if (!p) continue;
      if (addedTokens.has(p)) { c += 1; continue; }
      const bytes = Buffer.from(p, 'utf8');
      let mapped = '';
      for (const b of bytes) mapped += byteToUni.get(b);
      c += bpeCount(mapped);
    }
    while (textCacheChars + text.length > TEXT_CACHE_CHARS && textCache.size > 0) {
      const oldest = textCache.keys().next().value;
      textCacheChars -= oldest.length;
      textCache.delete(oldest);
    }
    textCache.set(text, c);
    textCacheChars += text.length;
    return c;
  }

  // 单条消息的可计内容:content 为字符串或 OpenAI 分段数组(仅计文本段,
  // 其他段(如图片)本模型不进上下文)
  function countMessage(m) {
    const c = m?.content;
    let total = typeof c === 'string' ? countText(c)
      : Array.isArray(c) ? c.reduce((s, p) => s + (typeof p?.text === 'string' ? countText(p.text) : 0), 0)
        : 0;
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += countText(tc?.function?.name || '');
        total += countText(typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '');
      }
    }
    return total;
  }

  // chat payload 的 prompt token 数(上游口径的本地复刻)。
  // 模板固定开销按 2026-09-10 oracle 校准:纯文本消息按 2+2n(实测 [u]=4/
  // [s,u]=4/[u,a]=5/[u,a,u]=8,本式恒高估 0~2,安全向);assistant 的每个
  // tool_call 与 tool 结果消息各有模板标记(+24/+18,实测合计 ≈30/对,
  // 略高估);tool_call_id 不渲染进 prompt(实测长 id 差 0)。tools 定义区
  // 被上游渲染为前导文案+逐 tool 块(实测基数 229+每 tool ≈ 其 JSON 序列化
  // 计数),取 236+Σ(序列化+2) 保守向
  function countPromptTokens(payload) {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    let total = 2 + 2 * msgs.length;
    for (const m of msgs) {
      total += countMessage(m);
      if (Array.isArray(m?.tool_calls)) total += 24 * m.tool_calls.length;
      if (m?.role === 'tool') total += 18;
    }
    if (Array.isArray(payload?.tools)) {
      total += 236 + payload.tools.reduce((s, t) => s + countText(JSON.stringify(t)) + 2, 0);
    }
    return total;
  }

  return { countText, countPromptTokens };
}

// 默认实例:懒加载 vendor 分词器(7.8MB JSON 解析约 300ms,一次性;启动
// 预热见 proxy.js)。测试用 createTokenizer 直接注入,不走文件
let defaultTokenizer = null;
function getTokenizer() {
  if (!defaultTokenizer) {
    const model = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'vendor', 'deepseek-tokenizer.json'), 'utf8'));
    defaultTokenizer = createTokenizer(model);
  }
  return defaultTokenizer;
}

module.exports = { createTokenizer, getTokenizer };
