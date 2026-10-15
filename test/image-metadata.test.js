'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { readImageMetadata } = require('../core/image-metadata');

// Real, complete images generated with Pillow 12.3.0 from solid RGB/RGBA
// canvases. They retain compressed image data, unlike a magic-byte-only stub.
const FIXTURES = {
  jpegExif6: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJABEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDJooor7Q+LCiiigD//2Q==',
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGOUaLjMAAZMEIqBgQEAGQcBb9W4BIQAAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJABEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDJooor7Q+LCiiigD//2Q==',
  progressive: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAHAA0DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAGQNC//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAEFAj//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAY/Aj//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/IT//2gAMAwEAAgADAAAAEAP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/ED//2Q==',
  vp8: 'UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoRAAkAPm0skkWkIqGYBABABsSgB2APwAAQigAA/ulpH//z0zXmD/Jz//5+Z3bi/nMAAA==',
  vp8l: 'UklGRh4AAABXRUJQVlA4TBEAAAAvDIABAAdQwGJ0uv+BiOh/AAA=',
  vp8x: 'UklGRmgAAABXRUJQVlA4WAoAAAAQAAAAEAAACAAAQUxQSAoAAAABB1DGiAhERP8DVlA4IDgAAAAQAwCdASoRAAkAPm0skkWkIqGYBABABsSgB2APwAAQigAA/ulpH//z0zXmD/Jz//5+Z3bi/nMAAA==',
  gif: 'R0lGODdhAwACAIEAABiA0wAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7',
  apng: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAADAAAAAgAAAAAAAAAAAAEACgAAP7ZcWAAAABBJREFUeJxj/M8ABUwwBgMAEykBA/DYB4QAAAAaZmNUTAAAAAEAAAADAAAAAgAAAAAAAAAAAAEACgAApMW2jAAAABhmZEFUAAAAAnicY2Rg+M8ABkwQioGBAQARKwEDo1SK+AAAAABJRU5ErkJggg==',
  animatedWebp: 'UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAgAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAIAAAEAAGQAAAJWUDggMgAAADABAJ0BKgMAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAACAAABAABkAAAAVlA4IC4AAAA0AQCdASoDAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA',
  animatedGif: 'R0lGODlhAwACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAAIBgABCBwYEAAh+QQBCgABACwAAAAAAwACAIEAAP8AAAAAAAAAAAAIBgABCBwYEAA7',
};
const bytes = name => Buffer.from(FIXTURES[name], 'base64');
const dataUrl = (format, data) => `data:image/${format};base64,${data.toString('base64')}`;
const read = (format, data) => readImageMetadata(dataUrl(format, data));

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

function changePng(mutator) {
  const png = bytes('png');
  mutator(png);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

function jpegSegment(marker, data) {
  const segment = Buffer.alloc(4 + data.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.length + 2, 2);
  data.copy(segment, 4);
  return segment;
}

function insertJpegApp(data) {
  const jpeg = bytes('jpeg');
  return Buffer.concat([jpeg.subarray(0, 2), jpegSegment(0xe1, data), jpeg.subarray(2)]);
}

function exifData(orientation = 6, littleEndian = false, ifdOffset = 8) {
  const data = Buffer.alloc(6 + ifdOffset + (orientation === null ? 6 : 18));
  data.write('Exif\0\0', 0, 6, 'latin1');
  const tiff = data.subarray(6), suffix = littleEndian ? 'LE' : 'BE';
  const u16 = (value, offset) => tiff[`writeUInt16${suffix}`](value, offset);
  const u32 = (value, offset) => tiff[`writeUInt32${suffix}`](value, offset);
  tiff.write(littleEndian ? 'II' : 'MM');
  u16(42, 2);
  u32(ifdOffset, 4);
  u16(orientation === null ? 0 : 1, ifdOffset);
  if (orientation !== null) {
    u16(0x0112, ifdOffset + 2);
    u16(3, ifdOffset + 4);
    u32(1, ifdOffset + 6);
    u16(orientation, ifdOffset + 10);
  }
  return data;
}

test('reads actual PNG, baseline/progressive JPEG, and VP8/VP8L/VP8X WebP files', () => {
  for (const [name, format, width, height] of [
    ['png', 'png', 3, 2], ['jpeg', 'jpeg', 17, 9], ['progressive', 'jpeg', 13, 7],
    ['jpegExif6', 'jpeg', 9, 17],
    ['vp8', 'webp', 17, 9], ['vp8l', 'webp', 13, 7], ['vp8x', 'webp', 17, 9],
  ]) assert.deepEqual(read(format, bytes(name)), { format, width, height }, name);
});

test('MIME matching is case-insensitive, accepts jpg, and requires the real signature', () => {
  assert.deepEqual(read('JPG', bytes('jpeg')), { format: 'jpeg', width: 17, height: 9 });
  assert.deepEqual(readImageMetadata(`DATA:IMAGE/PNG;BASE64,${FIXTURES.png}`), { format: 'png', width: 3, height: 2 });
  for (const [format, name] of [['png', 'jpeg'], ['jpeg', 'png'], ['webp', 'png'], ['gif', 'png']]) {
    assert.equal(read(format, bytes(name)), null);
  }
  for (const format of ['svg+xml', 'bmp', 'avif', 'x-png', 'not-real']) assert.equal(read(format, bytes('png')), null);
});

test('non-data URLs, malformed base64, parameters, and non-string values remain unknown', () => {
  const valid = dataUrl('png', bytes('png'));
  for (const input of [undefined, null, {}, [], 1, new String(valid),
    'https://example.invalid/image.png', 'http://127.0.0.1/image.png', 'file:///image.png',
    'data:image/png,raw-data', 'data:image/png;base64,', 'data:image/png;base64,A',
    valid.replace(';base64,', ';charset=utf-8;base64,'), `${valid}\n`, ` ${valid}`,
    valid.replace('iVBOR', 'iVB*R'), valid.replace('iVBOR', 'iV_OR'), valid.replace('iVBOR', 'iV OR'),
    valid.replace('iVBOR', 'iV=OR'), valid + '=', valid.replace(/I=$/, 'J='),
  ]) assert.equal(readImageMetadata(input), null, String(input).slice(0, 80));
  assert.deepEqual(readImageMetadata(valid.replace(/=+$/, '')), { format: 'png', width: 3, height: 2 });
});

test('GIF, APNG, and animated WebP never claim static dimensions', () => {
  for (const [format, name] of [['gif', 'gif'], ['gif', 'animatedGif'], ['png', 'apng'], ['webp', 'animatedWebp']]) {
    assert.equal(read(format, bytes(name)), null, name);
  }
  const apng = bytes('apng');
  const hidden = Buffer.concat([apng.subarray(0, 33), pngChunk('tEXt', Buffer.alloc(65536, 65)), apng.subarray(33)]);
  assert.equal(read('png', hidden), null, 'animation flag beyond the cap cannot establish static status');
});

test('every truncated PNG/JPEG header and every truncated RIFF file is rejected', () => {
  const png = bytes('png');
  const idat = png.indexOf('IDAT');
  const pngChunkEnd = idat + 8 + png.readUInt32BE(idat - 4);
  for (let cut = 0; cut < pngChunkEnd; cut++) assert.equal(read('png', png.subarray(0, cut)), null, `PNG ${cut}`);
  for (const name of ['jpeg', 'progressive', 'jpegExif6']) {
    const jpeg = bytes(name), sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    const scanStart = sos + 2 + jpeg.readUInt16BE(sos + 2);
    for (let cut = 0; cut <= scanStart; cut++) assert.equal(read('jpeg', jpeg.subarray(0, cut)), null, `${name} ${cut}`);
  }
  for (const name of ['vp8', 'vp8l', 'vp8x']) {
    const webp = bytes(name);
    for (let cut = 0; cut < webp.length; cut++) assert.equal(read('webp', webp.subarray(0, cut)), null, `${name} ${cut}`);
  }
});

test('PNG dimensions, IHDR fields, CRC, and chunk bounds are validated', () => {
  for (const [width, height] of [[0, 2], [3, 0], [65537, 1], [65536, 4097], [0xffffffff, 0xffffffff]]) {
    assert.equal(read('png', changePng(png => { png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20); })), null);
  }
  assert.deepEqual(read('png', changePng(png => { png.writeUInt32BE(65536, 16); png.writeUInt32BE(4096, 20); })),
    { format: 'png', width: 65536, height: 4096 });
  for (const [offset, value] of [[0, 0], [11, 12], [12, 0xc9], [24, 3], [25, 5], [26, 1], [27, 1], [28, 2]]) {
    assert.equal(read('png', changePng(png => { png[offset] = value; })), null, `offset ${offset}`);
  }
  const badCrc = bytes('png');
  badCrc[29] ^= 1;
  assert.equal(read('png', badCrc), null);
  const largeChunk = bytes('png');
  largeChunk.writeUInt32BE(0xffffffff, 33);
  assert.equal(read('png', largeChunk), null);
  const png = bytes('png');
  for (const chunk of [png.subarray(8, 33), pngChunk('ABCD', Buffer.alloc(0)), pngChunk('tExt', Buffer.alloc(0))]) {
    assert.equal(read('png', Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)])), null);
  }
});

test('PNG uses chunk boundaries for animation and refuses oversized pre-IDAT metadata', () => {
  const png = bytes('png');
  const text = pngChunk('tEXt', Buffer.from('note\0IDAT acTL fcTL fdAT are ordinary text here'));
  assert.deepEqual(read('png', Buffer.concat([png.subarray(0, 33), text, png.subarray(33)])), { format: 'png', width: 3, height: 2 });
  const largeText = pngChunk('tEXt', Buffer.alloc(65536, 65));
  assert.equal(read('png', Buffer.concat([png.subarray(0, 33), largeText, png.subarray(33)])), null);
});

test('PNG with pre-IDAT EXIF and WebP with EXIF metadata use the conservative fallback', () => {
  const tiff = exifData(6).subarray(6), png = bytes('png');
  assert.equal(read('png', Buffer.concat([png.subarray(0, 33), pngChunk('eXIf', tiff), png.subarray(33)])), null);
  const webp = bytes('vp8x');
  const exif = Buffer.alloc(8 + tiff.length);
  exif.write('EXIF', 0, 4, 'latin1');
  exif.writeUInt32LE(tiff.length, 4);
  tiff.copy(exif, 8);
  for (const position of [30, webp.length]) {
    const oriented = Buffer.concat([webp.subarray(0, position), exif, webp.subarray(position)]);
    oriented.writeUInt32LE(oriented.length - 8, 4);
    oriented[20] |= 8;
    assert.equal(read('webp', oriented), null, `EXIF chunk at ${position}`);
    if (position === 30) {
      oriented[20] &= ~8;
      assert.equal(read('webp', oriented), null, 'a visible EXIF chunk also rejects a missing VP8X flag');
    }
  }
  webp[20] |= 8;
  assert.equal(read('webp', webp), null, 'flagged EXIF remains unknown even if its chunk is missing');
});

test('JPEG respects APP segment boundaries instead of searching for SOF byte patterns', () => {
  const jpeg = bytes('jpeg');
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const decoy = Buffer.from(jpeg.subarray(sof, sof + 19));
  decoy.writeUInt16BE(1, 5);
  decoy.writeUInt16BE(1, 7);
  assert.deepEqual(read('jpeg', insertJpegApp(decoy)), { format: 'jpeg', width: 17, height: 9 });
  assert.equal(read('jpeg', insertJpegApp(Buffer.alloc(65533, 0xff))), null);
  const repeatedMarker = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff]), jpeg.subarray(2)]);
  assert.deepEqual(read('jpeg', repeatedMarker), { format: 'jpeg', width: 17, height: 9 });
  for (const length of [0, 1, 65535]) {
    const invalid = Buffer.from(jpeg);
    invalid.writeUInt16BE(length, 4);
    assert.equal(read('jpeg', invalid), null, `APP length ${length}`);
  }
});

test('JPEG applies all EXIF orientations from either TIFF byte order and non-default IFD offsets', () => {
  for (const littleEndian of [false, true]) {
    for (const ifdOffset of [8, 16]) {
      for (let orientation = 1; orientation <= 8; orientation++) {
        assert.deepEqual(read('jpeg', insertJpegApp(exifData(orientation, littleEndian, ifdOffset))),
          { format: 'jpeg', width: orientation >= 5 ? 9 : 17, height: orientation >= 5 ? 17 : 9 },
          `orientation ${orientation}, littleEndian ${littleEndian}, IFD ${ifdOffset}`);
      }
      assert.deepEqual(read('jpeg', insertJpegApp(exifData(null, littleEndian, ifdOffset))),
        { format: 'jpeg', width: 17, height: 9 });
    }
  }
  for (const [name, width, height] of [['jpeg', 9, 17], ['progressive', 7, 13]]) {
    const jpeg = bytes(name), sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    const appAfterFrame = Buffer.concat([jpeg.subarray(0, sos), jpegSegment(0xe1, exifData()), jpeg.subarray(sos)]);
    assert.deepEqual(read('jpeg', appAfterFrame), { format: 'jpeg', width, height });
  }
});

test('JPEG preserves dimensions without a main-image orientation, including thumbnail-only orientation', () => {
  const empty = exifData(null);
  empty.writeUInt32BE(14, 16); // IFD1 follows the empty IFD0 and applies only to the thumbnail.
  const thumbnailOnly = Buffer.concat([empty, exifData(8).subarray(14)]);
  assert.deepEqual(read('jpeg', insertJpegApp(thumbnailOnly)), { format: 'jpeg', width: 17, height: 9 });
  const unrelated = exifData();
  unrelated.writeUInt16BE(0x0128, 16); // ResolutionUnit is a valid unrelated inline SHORT.
  unrelated.writeUInt16BE(2, 24);
  assert.deepEqual(read('jpeg', insertJpegApp(unrelated)), { format: 'jpeg', width: 17, height: 9 });
  const description = Buffer.concat([exifData(), Buffer.from('Model\0')]);
  description.writeUInt16BE(0x010e, 16);
  description.writeUInt16BE(2, 18);
  description.writeUInt32BE(6, 20);
  description.writeUInt32BE(26, 24);
  assert.deepEqual(read('jpeg', insertJpegApp(description)), { format: 'jpeg', width: 17, height: 9 });
  assert.deepEqual(read('jpeg', insertJpegApp(Buffer.from('http://ns.adobe.com/xap/1.0/\0Exif ordinary XMP data'))),
    { format: 'jpeg', width: 17, height: 9 });
});

test('JPEG rejects malformed EXIF signatures, TIFF structures, and orientation values without throwing', () => {
  const exif = exifData();
  for (let cut = 4; cut < exif.length; cut++) {
    assert.equal(read('jpeg', insertJpegApp(exif.subarray(0, cut))), null, `EXIF truncated at ${cut}`);
  }
  const mutations = [
    data => { data[4] = 1; }, data => { data[5] = 1; }, data => { data[6] = 0; },
    data => data.writeUInt16BE(43, 8),
    ...[0, 4, 9, 0xffffffff].map(value => data => data.writeUInt32BE(value, 10)),
    data => data.writeUInt16BE(65535, 14),
    ...[0, 1, 4, 13, 65535].map(value => data => data.writeUInt16BE(value, 18)),
    ...[0, 2, 0xffffffff].map(value => data => data.writeUInt32BE(value, 20)),
    ...[0, 9, 65535].map(value => data => data.writeUInt16BE(value, 24)),
    ...[4, 8, 9, 26, 0xffffffff].map(value => data => data.writeUInt32BE(value, 28)),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const invalid = Buffer.from(exif);
    mutate(invalid);
    assert.equal(read('jpeg', insertJpegApp(invalid)), null, `EXIF mutation ${index}`);
  }
  const escapedValue = exifData();
  escapedValue.writeUInt16BE(0x010e, 16);
  escapedValue.writeUInt16BE(2, 18);
  escapedValue.writeUInt32BE(8, 20);
  for (const offset of [0, 8, 17, 0xffffffff]) {
    escapedValue.writeUInt32BE(offset, 24);
    assert.equal(read('jpeg', insertJpegApp(escapedValue)), null, `EXIF value offset ${offset}`);
  }
});

test('JPEG rejects duplicate orientation tags and conflicting EXIF segments conservatively', () => {
  for (const secondOrientation of [6, 8]) {
    const first = exifData(6), second = exifData(secondOrientation);
    const duplicate = Buffer.concat([first.subarray(0, 28), second.subarray(16, 28), Buffer.alloc(4)]);
    duplicate.writeUInt16BE(2, 14);
    assert.equal(read('jpeg', insertJpegApp(duplicate)), null);
  }
  const jpeg = bytes('jpeg');
  for (const [first, second, accepted] of [[6, 6, true], [null, null, true], [1, 2, false],
    [5, 6, false], [1, 6, false], [6, 1, false], [null, 6, false], [6, null, false]]) {
    const multiple = Buffer.concat([jpeg.subarray(0, 2), jpegSegment(0xe1, exifData(first)),
      jpegSegment(0xe1, exifData(second)), jpeg.subarray(2)]);
    assert.deepEqual(read('jpeg', multiple), accepted
      ? { format: 'jpeg', width: first === 6 ? 9 : 17, height: first === 6 ? 17 : 9 } : null,
    `EXIF segments ${first}, ${second}`);
  }
});

test('JPEG EXIF parsing stays inside the existing 64 KiB header budget', () => {
  const jpeg = bytes('jpegExif6'), sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  const scanStart = sos + 2 + jpeg.readUInt16BE(sos + 2);
  for (const extra of [0, 1]) {
    const padded = Buffer.concat([jpeg.subarray(0, 2),
      jpegSegment(0xe2, Buffer.alloc(65536 - scanStart - 4 + extra)), jpeg.subarray(2)]);
    assert.deepEqual(read('jpeg', padded), extra ? null : { format: 'jpeg', width: 9, height: 17 });
  }
});

test('JPEG validates SOF dimensions/components and SOS structure', () => {
  const jpeg = bytes('jpeg');
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  for (const [offset, value] of [[sof + 3, 10], [sof + 4, 0], [sof + 6, 0], [sof + 9, 0],
    [sof + 11, 0], [sof + 12, 4], [sos + 4, 0], [sos + 5, 42], [2, 0], [3, 0xd9]]) {
    const invalid = Buffer.from(jpeg);
    invalid[offset] = value;
    assert.equal(read('jpeg', invalid), null, `offset ${offset}`);
  }
  for (const [width, height] of [[0, 9], [17, 0], [65535, 65535]]) {
    const invalid = Buffer.from(jpeg);
    invalid.writeUInt16BE(height, sof + 5);
    invalid.writeUInt16BE(width, sof + 7);
    assert.equal(read('jpeg', invalid), null);
  }
});

test('JPEG accepts a complete header at the 64 KiB limit and refuses one beyond it', () => {
  const jpeg = bytes('jpeg'), sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  const scanStart = sos + 2 + jpeg.readUInt16BE(sos + 2);
  assert.deepEqual(read('jpeg', insertJpegApp(Buffer.alloc(65536 - scanStart - 4))),
    { format: 'jpeg', width: 17, height: 9 });
  assert.equal(read('jpeg', insertJpegApp(Buffer.alloc(65537 - scanStart - 4))), null);
});

test('hierarchical/differential JPEG and unknown extensions use the fallback', () => {
  const jpeg = bytes('jpeg');
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const frame = Buffer.from(jpeg.subarray(sof + 4, sof + 19));
  frame.writeUInt16BE(4096, 1);
  frame.writeUInt16BE(4096, 3);
  for (const marker of [0xde, 0xdf, 0xc8, 0xf0]) {
    const extended = Buffer.concat([jpeg.subarray(0, 2), jpegSegment(marker, frame), jpeg.subarray(2)]);
    assert.equal(read('jpeg', extended), null);
  }
  for (const marker of [0xc5, 0xc6, 0xc7, 0xcd, 0xce, 0xcf]) {
    const differential = Buffer.from(jpeg);
    differential[sof + 1] = marker;
    assert.equal(read('jpeg', differential), null);
  }
});

test('WebP validates RIFF sizes, signatures, VP8 keyframe/scale fields, and VP8L versions', () => {
  for (const [name, offset, value] of [
    ['vp8', 0, 0xd2], ['vp8', 8, 0xd7], ['vp8', 4, 0], ['vp8', 16, 0xff],
    ['vp8', 20, 0x11], ['vp8', 20, 0x00], ['vp8', 23, 0], ['vp8', 27, 0x40],
    ['vp8', 26, 0], ['vp8l', 20, 0], ['vp8l', 24, 0xe0],
  ]) {
    const invalid = bytes(name);
    invalid[offset] = value;
    assert.equal(read('webp', invalid), null, `${name} offset ${offset}`);
  }
  const padding = bytes('vp8l');
  assert.equal(read('webp', padding.subarray(0, padding.length - 1)), null);
});

test('WebP extended canvas agrees with bitstream and rejects animation/reserved flags', () => {
  for (const [offset, value] of [[20, 2], [20, 0x80], [20, 1], [21, 1], [22, 1], [23, 1], [24, 17], [27, 9]]) {
    const invalid = bytes('vp8x');
    invalid[offset] = value;
    assert.equal(read('webp', invalid), null, `offset ${offset}`);
  }
  const excessive = bytes('vp8x');
  excessive.writeUIntLE(65536, 24, 3);
  assert.equal(read('webp', excessive), null);
  for (const type of ['ANIM', 'ANMF']) {
    const invalid = bytes('vp8x');
    invalid.write(type, 30, 4, 'latin1');
    assert.equal(read('webp', invalid), null);
  }
});

test('multi-megabyte input only copies a bounded base64 prefix and decodes at most 64 KiB', () => {
  const png = bytes('png');
  const text = Buffer.alloc(2 * 1024 * 1024, 65);
  text.write('note\0');
  const large = Buffer.concat([png.subarray(0, -12), pngChunk('tEXt', text), png.subarray(-12)]);
  const url = dataUrl('png', large);
  const original = Buffer.prototype.write;
  const calls = [];
  try {
    Buffer.prototype.write = function (value, offset, length, encoding) {
      if (encoding === 'base64') calls.push({ length: value.length, capacity: this.length });
      return original.apply(this, arguments);
    };
    assert.deepEqual(readImageMetadata(url), { format: 'png', width: 3, height: 2 });
  } finally {
    Buffer.prototype.write = original;
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].length <= Math.ceil(65536 / 3) * 4);
  assert.ok(calls[0].capacity <= 65536);
});

test('deterministic malformed headers never throw or produce unbounded dimensions', () => {
  let state = 0x8badf00d;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const formats = [['png', 'png'], ['jpeg', 'jpeg'], ['jpeg', 'jpegExif6'],
    ['webp', 'vp8'], ['webp', 'vp8l'], ['webp', 'vp8x']];
  for (let i = 0; i < 500; i++) {
    const [format, name] = formats[i % formats.length], data = bytes(name);
    for (let j = 0; j < 4; j++) data[random() % Math.min(64, data.length)] = random() & 255;
    let result;
    assert.doesNotThrow(() => { result = read(format, data); });
    if (result) {
      assert.ok(result.width > 0 && result.width <= 65536);
      assert.ok(result.height > 0 && result.height <= 65536);
      assert.ok(result.width * result.height <= 268435456);
    }
  }
});
