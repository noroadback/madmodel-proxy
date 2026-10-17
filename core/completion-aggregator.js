// core/completion-aggregator.js
// 非流式聚合:把上游 SSE delta 流拼回完整 chat.completion 对象(纯数据变换)。
// 不依赖 HTTP、fetch、AbortController、环境变量或文件系统。

'use strict';

const { readReasoningDelta } = require('./thinking');

function createAggregator(model = '', thinkingField = null) {
  return {
    id: '', model,
    content: '', reasoning: '',
    toolCalls: Object.create(null), // index → {id, type, function:{name, arguments}}
    invalidToolCalls: false,
    finish: null, usage: null, created: 0,
    feed(obj) {
      if (obj.id) this.id = obj.id;
      if (obj.created) this.created = obj.created;
      if (obj.model) this.model = obj.model;
      if (obj.usage) this.usage = obj.usage;
      const ch = obj.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) this.finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string') this.content += d.content;
      // 思考字段名逐模型不同(见 thinking.js 的 REASONING_FIELDS):只认
      // `reasoning_content` 会让 qwen 的 `reasoning` 整段丢掉,非流式交付的
      // 回复里就永远没有思考。交付名统一为 `reasoning_content`(下方 result)
      const r = readReasoningDelta(d, thinkingField);
      if (r !== null) this.reasoning += r;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (!tc || typeof tc !== 'object' || Array.isArray(tc)) {
            this.invalidToolCalls = true;
            continue;
          }
          const i = tc.index != null ? tc.index : 0;
          if (!Number.isSafeInteger(i) || i < 0) {
            const error = new Error('上游工具调用索引无效');
            error.code = 'UPSTREAM_TOOL_INDEX';
            throw error;
          }
          // 续帧可省略字段或传 null；显式错误类型则必须记住，不能被默认值、
          // 字符串拼接或后续正常帧洗掉。调用方在交付前同时检查这个标志。
          const fn = tc.function;
          if ((tc.type != null && tc.type !== 'function') ||
              (tc.id != null && typeof tc.id !== 'string') ||
              (fn != null && (typeof fn !== 'object' || Array.isArray(fn))) ||
              (fn?.name != null && typeof fn.name !== 'string') ||
              (fn?.arguments != null && typeof fn.arguments !== 'string')) {
            this.invalidToolCalls = true;
            continue;
          }
          if (!this.toolCalls[i]) this.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) this.toolCalls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) this.toolCalls[i].function.name += tc.function.name;
            if (tc.function.arguments) this.toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    },
    result() {
      const message = { role: 'assistant', content: this.content || null };
      if (this.reasoning) message.reasoning_content = this.reasoning;
      // 保留出现过的每个索引。过滤缺 id/name 的项会让交付校验漏掉它们，
      // 而流式路径随后仍会冲刷含这些半截调用的原始帧。
      const toolList = Object.keys(this.toolCalls).sort((a, b) => Number(a) - Number(b))
        .map(k => this.toolCalls[k]);
      if (toolList.length) message.tool_calls = toolList;
      return {
        id: this.id || `chatcmpl-proxy-${Date.now()}`,
        object: 'chat.completion',
        created: this.created || Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{ index: 0, message, finish_reason: this.finish || 'stop' }],
        usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

module.exports = { createAggregator };
