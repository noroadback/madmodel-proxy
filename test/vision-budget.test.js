'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { estimateVisionBudget, UNKNOWN_IMAGE_TOKENS } = require('../core/vision-budget');

const DS = 'DeepSeek-V4.1-Flash';
const QWEN = 'qwen3.8-27b';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const buffer = Buffer.alloc(bytes.length + 12);
  buffer.writeUInt32BE(bytes.length);
  buffer.write(type, 4, 4, 'latin1');
  bytes.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, buffer.length - 4)), buffer.length - 4);
  return buffer;
}

// Complete valid grayscale PNGs, using one bit per pixel to keep even the
// largest dimension/range fixtures small without mocking metadata parsing.
function png(width, height, shade = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  const stride = 1 + Math.ceil(width / 8);
  const pixels = Buffer.alloc(stride * height, shade ? 255 : 0);
  for (let row = 0; row < height; row++) pixels[row * stride] = 0;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const image = (url, detail) => ({ type: 'image_url', image_url: detail === undefined ? { url } : { url, detail } });
const payload = (model, ...images) => ({ model, messages: [{ role: 'user', content: [
  { type: 'text', text: 'Inspect this.' }, ...images,
] }] });
const small = png(32, 32);
const medium = png(512, 512);

test('no images returns a complete zero estimate and does not mutate the request', () => {
  const request = Object.freeze({ model: DS, messages: Object.freeze([{ content: 'hello' }]) });
  const expected = { imageCount: 0, imageTokensEstimate: 0, imageMarginTokens: 0,
    dimensionImageCount: 0, unknownImageCount: 0, imageEstimateSource: 'none' };
  for (const input of [request, {}, null, undefined]) assert.deepEqual(estimateVisionBudget(input), expected);
});

test('DeepSeek calibration preserves observed size and orientation behavior', () => {
  for (const [width, height, tokens] of [[32, 32, 184], [512, 512, 184], [1024, 1024, 652],
    [546, 546, 184], [547, 547, 212], [1280, 1280, 994], [1344, 1344, 994],
    [2048, 2048, 994], [4096, 4096, 994], [1000, 2000, 1014],
    [768, 1024, 502], [1024, 768, 496], [256, 2048, 394], [2048, 256, 352]]) {
    const result = estimateVisionBudget(payload(DS, image(png(width, height))));
    assert.equal(result.imageTokensEstimate, tokens, `${width}x${height}`);
    assert.equal(result.imageMarginTokens, 8);
    assert.equal(result.imageEstimateSource, 'dimensions');
  }
});

test('DeepSeek official resize corrects the measured 320x640 underestimate', () => {
  const result = estimateVisionBudget(payload(DS, image(png(320, 640))));
  assert.equal(result.imageTokensEstimate, 211);
  assert.equal(result.imageMarginTokens, 8);
});

test('Qwen preserves upstream half-even rounding, small-image scaling and image markers', () => {
  for (const [width, height, tokens] of [[32, 32, 66], [512, 512, 258], [1024, 1024, 1026],
    [768, 1024, 770], [513, 513, 258], [528, 528, 258], [529, 529, 291],
    [560, 560, 326], [592, 592, 326], [239, 239, 83], [32, 64, 74],
    [2048, 2048, 4098], [4096, 4096, 16386], [4160, 4160, 16386], [4096, 8192, 16292]]) {
    const result = estimateVisionBudget(payload(QWEN, image(png(width, height))));
    assert.equal(result.imageTokensEstimate, tokens, `${width}x${height}`);
    assert.equal(result.imageMarginTokens, 8);
  }
});

test('dimension formulas reproduce captured upstream observations including independent holdouts', () => {
  const { observations } = require('./fixtures/vision-token-observations.json');
  for (const { model, width, height, count, detail, imageTokens } of observations) {
    const part = image(png(width, height), detail);
    const result = estimateVisionBudget(payload(model, ...Array(count).fill(part)));
    assert.equal(result.imageTokensEstimate, imageTokens, `${model} ${width}x${height} x${count} ${detail}`);
    assert.equal(result.imageMarginTokens, 8 * count);
  }
});

test('calibrated model aliases and detail values are exact, with no low-detail discount', () => {
  for (const detail of [undefined, 'auto', 'low', 'high']) {
    assert.equal(estimateVisionBudget(payload(DS, image(medium, detail))).imageTokensEstimate, 184);
  }
  for (const model of ['DeepSeek-V4-Flash-0731', 'DeepSeek-V4.1-Flash-other', 'QWEN3.8-27B', 'other', undefined]) {
    const result = estimateVisionBudget(payload(model, image(medium)));
    assert.equal(result.imageTokensEstimate, UNKNOWN_IMAGE_TOKENS);
    assert.equal(result.imageMarginTokens, 0);
    assert.equal(result.imageEstimateSource, 'heuristic');
  }
  for (const detail of ['original', 'LOW', '', null, 1, {}]) {
    assert.equal(estimateVisionBudget(payload(DS, image(medium, detail))).imageEstimateSource, 'heuristic');
  }
});

test('remote, malformed, animated/unsupported, out-of-range, and extreme images use fallback', () => {
  const gif = 'data:image/gif;base64,R0lGODdhAwACAIEAABiA0wAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
  const inputs = ['https://example.invalid/private.png', 'data:image/png;base64,AAAA',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', gif, png(8193, 2048), png(4096, 511), null];
  for (const url of inputs) {
    const result = estimateVisionBudget(payload(DS, image(url)));
    assert.equal(result.imageTokensEstimate, UNKNOWN_IMAGE_TOKENS);
    assert.equal(result.imageMarginTokens, 0);
    assert.equal(result.unknownImageCount, 1);
  }
  assert.equal(estimateVisionBudget(payload(DS, image(png(4096, 512)))).dimensionImageCount, 1);
  assert.equal(estimateVisionBudget(payload(DS, { type: 'image_url' })).unknownImageCount, 1);
});

test('mixed images across messages add estimates and margins without counting other content', () => {
  const request = payload(DS, image(small));
  request.messages.push({ role: 'assistant', content: [image(medium), image('https://example.invalid/a'),
    { type: 'text', text: 'image_url' }, { type: 'input_audio', input_audio: {} }] });
  assert.deepEqual(estimateVisionBudget(request), { imageCount: 3,
    imageTokensEstimate: 184 * 2 + UNKNOWN_IMAGE_TOKENS, imageMarginTokens: 8 * 2,
    dimensionImageCount: 2, unknownImageCount: 1, imageEstimateSource: 'mixed' });
});
