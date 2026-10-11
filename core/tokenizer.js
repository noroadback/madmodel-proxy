// 使用随包分发的 DeepSeek 词表估算文本 token，不依赖网络。
// byte-level BPE 配合片段与整段缓存，复用历史消息的计数。
// 不同模型、模板和多模态输入会产生偏差；预算余量由 payload.js 处理。

'use strict';

const fs = require('fs');
const path = require('path');
const { readReasoningDelta } = require('./thinking');

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

// ---- BPE 合并的实现(模块级,签名为 (piece, mergeRank, vocab) -> token 数) ----

// 堆式实现(1.8.1 起的生产路径):链表 + 最小堆,整体 O(n log n)。
// 正确性约束(与测试中的旧算法对照，见 test/tokenizer.test.js):
//   - 每次合并取 merge rank 最小的相邻对,同 rank 取最左出现。堆排序键为
//     (rank, 左节点票据),票据由存活的左节点继承,恒等于该节点最左成分
//     字符的初始位置——链表顺序不变,小票据即靠左
//   - rank 与 pair 字符串一一对应(mergeRank 是双射),弹出时重查
//     rank 与相邻关系即可完成惰性失效校验(节点死亡/字符变/相邻变都拒)
// 取代旧实现的原因:数组全扫描 + splice 最坏 O(n²),8KB 同字符实测
// 1021ms、6,000 无标点中文 9305ms,同步阻塞整个代理事件循环
function heapBpe(piece, mergeRank, vocab) {
  const n = piece.length;
  if (n < 2) return n === 1 && vocab.has(piece) ? 1 : 0;
  // 链表:ch/prv/nxt 平行数组,下标即节点 id;左节点吸收右节点,故表头 0 永不死。
  // 尾节点哨兵为 -1(nxt[n-1] = -1),计数遍历以 i !== -1 终止。
  // alive 是失效校验的关键:被吸收的节点其 nxt/ch 都不会被改写,仅凭
  // nxt[li]===ri 与 rank 复查无法识别死节点(实测在代码密集样本上翻车),
  // 必须显式查存活
  const ch = new Array(n), prv = new Array(n), nxt = new Array(n), ticket = new Array(n);
  const alive = new Array(n).fill(true);
  for (let i = 0; i < n; i++) { ch[i] = piece[i]; prv[i] = i - 1; nxt[i] = i + 1; ticket[i] = i; }
  nxt[n - 1] = -1;
  const heap = []; // 条目 [rank, 票据, 左id, 右id]
  const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const hpush = e => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!lt(heap[i], heap[p])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const hpop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && lt(heap[l], heap[m])) m = l;
        if (r < heap.length && lt(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i + 1 < n; i++) {
    const r = mergeRank.get(ch[i] + ' ' + ch[i + 1]);
    if (r !== undefined) hpush([r, i, i, i + 1]);
  }
  while (heap.length) {
    const [rank, , li, ri] = hpop();
    if (!alive[li] || !alive[ri] || nxt[li] !== ri) continue; // 惰性失效:死节点或相邻关系已变
    if (mergeRank.get(ch[li] + ' ' + ch[ri]) !== rank) continue; // 左字符已变
    ch[li] += ch[ri];
    alive[ri] = false;
    const after = nxt[ri];
    nxt[li] = after;
    if (after !== -1) prv[after] = li;
    const p = prv[li];
    if (p !== -1) {
      const r = mergeRank.get(ch[p] + ' ' + ch[li]);
      if (r !== undefined) hpush([r, ticket[p], p, li]);
    }
    if (after !== -1) {
      const r = mergeRank.get(ch[li] + ' ' + ch[after]);
      if (r !== undefined) hpush([r, ticket[li], li, after]);
    }
  }
  let c = 0;
  for (let i = 0; i !== -1; i = nxt[i]) if (vocab.has(ch[i])) c += 1;
  return c;
}

function createTokenizer(model, opts = {}) {
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
  // BPE 实现可注入(opts.bpeImpl,签名 (piece, mergeRank, vocab) -> token 数):
  // 默认堆式，测试可注入旧算法做差分验证。
  const bpeImpl = typeof opts.bpeImpl === 'function' ? opts.bpeImpl : heapBpe;
  function bpeCount(piece) {
    let c = pieceCache.get(piece);
    if (c !== undefined) return c;
    c = bpeImpl(piece, mergeRank, vocab);
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

  // 单条消息的可计内容:content 为字符串或 OpenAI 分段数组。
  // 这里只计文本与工具字段，图片余量在 payload.js 中单独预留。
  function countMessage(m) {
    const c = m?.content;
    let total = typeof c === 'string' ? countText(c)
      : Array.isArray(c) ? c.reduce((s, p) => s + (typeof p?.text === 'string' ? countText(p.text) : 0), 0)
        : 0;
    // 工具循环会把历史思考一并回传；即使上游有时丢弃旧轮次，也按保守口径计入。
    // 同义字段只计一次，正文中的普通 text 则保持独立。
    if (m?.role === 'assistant') total += countText(readReasoningDelta(m) || '');
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
