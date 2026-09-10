# vendor/

## deepseek-tokenizer.json

DeepSeek-V3 的公开分词器文件(HuggingFace `deepseek-ai/DeepSeek-V3`,MIT License),
2026-09-10 从 `https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json` 下载,未做任何修改。

**为什么 vendor**:2026-09-10 实测确认学校 madmodel 的 DeepSeek-V4-Flash-0731
沿用同一分词器(本地复刻计 token 与上游 `usage.prompt_tokens` 在 24 万 token 级
payload 上逐个吻合,差异仅为 chat 模板固定开销)。代理据此在本地精确计量
prompt tokens,413 预检与 max_tokens 收缩不再依赖估算(详见 core/tokenizer.js
与 CHANGELOG 1.6.0)。

上游换模型/换分词器时,本文件与上游计数可能漂移——以
`usage.prompt_tokens` 对测为准(测试套件中钉有 oracle 验证过的样本)。
