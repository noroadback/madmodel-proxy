# 第三方声明 / Third-Party Notices

本仓库包含以下第三方软件的衍生代码。

## DeepSeek-V3 tokenizer(vendored)

- 文件:`vendor/deepseek-tokenizer.json`,来自 [HuggingFace `deepseek-ai/DeepSeek-V3`](https://huggingface.co/deepseek-ai/DeepSeek-V3) 的 `tokenizer.json`,2026-09-10 下载,未做任何修改
- 该仓库为双许可:代码 MIT(`LICENSE-CODE`),模型权重另受 Model License 约束。tokenizer.json 属仓库数据文件,按上游标注的 MIT 提供
- 许可:MIT,版权人 DeepSeek(`Copyright (c) 2023 DeepSeek`),全文如下:

```
Copyright (c) 2023 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek-V4.1-Flash 图片尺寸算法

- `core/vision-budget.js` 中的 `deepseekImageTokens` 改写自官方 [`inference/image_processor.py`](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/5254448103b6254fc646dacbca1cbbf20e9216c1/inference/image_processor.py)，参数来自同版本 [`inference/config.json`](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/5254448103b6254fc646dacbca1cbbf20e9216c1/inference/config.json)。固定版本为 `5254448103b6254fc646dacbca1cbbf20e9216c1`。
- 修改内容为将纯尺寸计算移植到 JavaScript，并在代理中限制支持的尺寸范围；不分发或加载模型权重，也不引入原处理器的运行依赖。
- 上游 [LICENSE](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/5254448103b6254fc646dacbca1cbbf20e9216c1/LICENSE) 为 MIT，版权声明为 `Copyright (c) 2023 DeepSeek`，许可全文与本文前述 DeepSeek MIT 文本相同，并适用于该衍生算法。

## Transformers / Qwen 图片尺寸算法

- `core/vision-budget.js` 中的 `qwenImageTokens` 和 Python 半格取偶舍入的 JavaScript 实现，改写自 Transformers [`image_processing_qwen2_vl.py` 中的 `smart_resize`](https://github.com/huggingface/transformers/blob/8cb5963cc22174954e7dca2c0a3320b7dc2f4edc/src/transformers/models/qwen2_vl/image_processing_qwen2_vl.py#L54-L80)。固定提交为 `8cb5963cc22174954e7dca2c0a3320b7dc2f4edc`（`v4.57.1`）。参数来自 [Qwen/Qwen3.8-27B 的固定版本预处理配置](https://huggingface.co/Qwen/Qwen3.8-27B/blob/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0/preprocessor_config.json)。
- 源文件版权声明为 `Copyright 2024 The Qwen team, Alibaba Group and the HuggingFace Inc. team. All rights reserved.`。Transformers 仓库 LICENSE 另保留 `Copyright 2018- The Hugging Face team. All rights reserved.`。
- 修改内容为纯尺寸算法的 JavaScript 移植，保留上游取整方式与运算顺序，并增加代理自身的输入范围限制、图片起止标记计数与软余量。未引入 Transformers、PyTorch 或模型运行依赖。
- 许可为 Apache License 2.0，固定提交的原始许可全文随仓库保存在 [`vendor/licenses/transformers-LICENSE`](vendor/licenses/transformers-LICENSE)。该衍生部分适用 Apache License 2.0，不受本项目默认 MIT 许可替代。

## sm-crypto(vendored)

- 文件:`sm2.js`,来自 [sm-crypto](https://github.com/JuneAndGreen/sm-crypto) **v0.3.13** 的 `dist/sm2.js`
- 除文件顶部添加的版权说明块外，代码与上游发布产物逐字节相同；去掉该说明块后的 MD5 为 `da564086e629c5dcfb7934b6920b0323`
- 许可:MIT,版权人 june01,全文如下:

```
Copyright © 2018 june01

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## jsbn(sm-crypto 的上游依赖,打包于 sm2.js 内)

`sm2.js` 的 bundle 中包含 [jsbn](https://github.com/andyperlitch/jsbn)(Tom Wu 的 BigInteger/SecureRandom 实现,即其中的大数运算与 RC4 随机池模块)的衍生代码。jsbn 的许可为 MIT 变体,**附带一条额外的保留条款**("All redistributions must retain an intact copy of this copyright notice and disclaimer"),全文如下:

```
/*
 * Copyright (c) 2003-2005  Tom Wu
 * All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS-IS" AND WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS, IMPLIED OR OTHERWISE, INCLUDING WITHOUT LIMITATION, ANY
 * WARRANTY OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 *
 * IN NO EVENT SHALL TOM WU BE LIABLE FOR ANY SPECIAL, INCIDENTAL,
 * INDIRECT OR CONSEQUENTIAL DAMAGES OF ANY KIND, OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER OR NOT ADVISED OF
 * THE POSSIBILITY OF DAMAGE, AND ON ANY THEORY OF LIABILITY, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * In addition, the following condition applies:
 *
 * All redistributions must retain an intact copy of this copyright notice
 * and disclaimer.
 */
```
