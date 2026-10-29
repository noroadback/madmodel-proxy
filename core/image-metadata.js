'use strict';

// Header metadata only: no network, pixel decoding, or whole-image base64 copy.
// A null result deliberately leaves unsupported/ambiguous input on the caller's
// conservative fallback. This is not a validator for compressed pixel data.
const HEADER_LIMIT = 64 * 1024;
const BASE64_LIMIT = Math.ceil(HEADER_LIMIT / 3) * 4;
const MAX_DIMENSION = 65536;
const MAX_AREA = 268435456;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]);

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[i] = crc >>> 0;
}

function metadata(format, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_AREA) return null;
  return { format, width, height };
}

function readDataImage(url) {
  if (typeof url !== 'string') return null;
  // Match only a bounded prefix, including for huge non-data/remote URLs.
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,/i.exec(url.slice(0, 64));
  if (!match) return null;
  const start = match[0].length;
  const length = url.length - start;
  if (!length || length % 4 === 1) return null;
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
  if (padding && length % 4 !== 0) return null;
  const prefix = url.slice(start, start + BASE64_LIMIT);
  const complete = prefix.length === length;
  if (!(complete ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(prefix) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(url.slice(Math.max(start, url.length - 4)))) return null;
  const dataLength = length - padding;
  const lastValue = BASE64_ALPHABET.indexOf(url[url.length - padding - 1]);
  if ((dataLength % 4 === 2 && (lastValue & 15)) ||
      (dataLength % 4 === 3 && (lastValue & 3))) return null;
  const byteLength = Math.floor(dataLength * 3 / 4);
  if (byteLength < 12) return null;
  // Buffer.write caps decoded output at 64 KiB, even though the final base64
  // quantum can describe up to two additional bytes. The unseen body is not
  // scanned/validated; both time and temporary storage stay bounded.
  const bytes = Buffer.alloc(Math.min(byteLength, HEADER_LIMIT));
  const written = bytes.write(prefix, 0, bytes.length, 'base64');
  return { bytes: bytes.subarray(0, written), byteLength,
    format: /^jpe?g$/i.test(match[1]) ? 'jpeg' : match[1].toLowerCase() };
}

function pngCrc(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readPng(bytes, byteLength) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const result = metadata('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  const depth = bytes[24], color = bytes[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!result || !depths[color]?.includes(depth) || bytes[26] !== 0 ||
      bytes[27] !== 0 || bytes[28] > 1) return null;
  let offset = 8, palette = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > byteLength || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return null;
    // APNG's acTL precedes the first IDAT. If that boundary cannot be reached
    // within the header cap, static status is unknown and we return null.
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return null;
    // PNG EXIF orientation is not established by the JPEG-specific path.
    if (type === 'eXIf') return null;
    if (type === 'IDAT') return color === 3 && !palette ? null : result;
    if (end > bytes.length || pngCrc(bytes, offset + 4, end - 4) !== bytes.readUInt32BE(end - 4)) return null;
    if (type === 'IHDR') {
      if (offset !== 8) return null;
    } else if (type === 'PLTE') {
      if (palette || length < 3 || length > 768 || length % 3 || color === 0 || color === 4 ||
          (color === 3 && length / 3 > 2 ** depth)) return null;
      palette = true;
    } else if (type[0] === type[0].toUpperCase()) {
      // Unknown critical chunks and IEND before image data are unsupported.
      return null;
    }
    offset = end;
  }
  return null;
}

function readExifOrientation(bytes) {
  if (bytes.length < 14 || bytes.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const tiff = bytes.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const u16 = offset => order === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const u32 = offset => order === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || (ifd & 1) || ifd + 2 > tiff.length) return null;
  const count = u16(ifd), tableEnd = ifd + 2 + count * 12;
  if (tableEnd + 4 > tiff.length) return null;
  const nextIfd = u32(tableEnd);
  // A thumbnail IFD does not set the main image's orientation. Check its
  // pointer bounds without following subdirectories or thumbnail pixels.
  if (nextIfd && (nextIfd < 8 || (nextIfd & 1) || nextIfd + 6 > tiff.length ||
      (nextIfd >= ifd && nextIfd < tableEnd + 4))) return null;
  let orientation = null;
  const typeSizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const type = u16(entry + 2), values = u32(entry + 4);
    if (!typeSizes[type] || !values) return null;
    const size = typeSizes[type] * values;
    if (size > 4) {
      const valueOffset = u32(entry + 8), valueEnd = valueOffset + size;
      if (valueOffset < 8 || (valueOffset & 1) || valueEnd > tiff.length ||
          (valueOffset < tableEnd + 4 && valueEnd > ifd)) return null;
    }
    if (u16(entry) !== 0x0112) continue;
    // Orientation is one inline SHORT. Duplicate tags are ambiguous even
    // when their values agree; never guess which a decoder would use.
    if (orientation !== null || type !== 3 || values !== 1) return null;
    orientation = u16(entry + 8);
    if (orientation < 1 || orientation > 8) return null;
  }
  return orientation ?? 1;
}

function readJpeg(bytes, byteLength) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2, frame = null, componentIds = null, orientation = null;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0x01) continue; // TEM has no length field.
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker === 0xe1 && bytes.toString('latin1', offset + 2, Math.min(end, offset + 6)) === 'Exif') {
      const parsed = readExifOrientation(bytes.subarray(offset + 2, end));
      if (parsed === null || (orientation !== null && orientation !== parsed)) return null;
      orientation = parsed;
    } else if (SOF_MARKERS.has(marker)) {
      if (frame || length < 11) return null;
      const count = bytes[offset + 7];
      const precision = bytes[offset + 2];
      const lossless = marker === 0xc3 || marker === 0xcb;
      if (count < 1 || count > 4 || length !== 8 + 3 * count ||
          (lossless ? precision < 2 || precision > 16 : precision !== 8 && precision !== 12) ||
          (marker === 0xc0 && precision !== 8)) return null;
      frame = metadata('jpeg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      if (!frame) return null;
      componentIds = new Set();
      for (let i = 0; i < count; i++) {
        const pos = offset + 8 + i * 3;
        const sampling = bytes[pos + 1];
        if (componentIds.has(bytes[pos]) || !(sampling >> 4) || (sampling >> 4) > 4 ||
            !(sampling & 15) || (sampling & 15) > 4 || bytes[pos + 2] > 3) return null;
        componentIds.add(bytes[pos]);
      }
    } else if (marker === 0xda) {
      if (!frame || length < 8) return null;
      const count = bytes[offset + 2];
      if (count < 1 || count > componentIds.size || length !== 6 + 2 * count || end >= byteLength) return null;
      const scanIds = new Set();
      for (let i = 0; i < count; i++) {
        const id = bytes[offset + 3 + i * 2];
        if (!componentIds.has(id) || scanIds.has(id)) return null;
        scanIds.add(id);
      }
      return orientation >= 5 ? metadata('jpeg', frame.height, frame.width) : frame;
    } else if (marker !== 0xc4 && marker !== 0xcc && marker !== 0xdb && marker !== 0xdd &&
        marker !== 0xfe && !(marker >= 0xe0 && marker <= 0xef)) {
      // Hierarchical/differential JPEG and extension markers may alter the
      // final canvas; only recognized non-hierarchical headers are supported.
      return null;
    }
    // Segment lengths are authoritative: SOF-like bytes inside APP/COM data
    // must never be mistaken for the actual frame header.
    offset = end;
  }
  return null;
}

function readWebp(bytes, byteLength) {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== byteLength) return null;
  let offset = 12, canvas = null;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length + (length & 1);
    if (end > byteLength) return null;
    if (type === 'ANIM' || type === 'ANMF' || type === 'EXIF') return null;
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || start + length > bytes.length ||
          // EXIF may follow compressed pixels, outside the bounded prefix.
          (bytes[start] & 0xcb) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) return null;
      canvas = metadata('webp', bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
      if (!canvas) return null;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (!canvas && offset !== 12) return null;
      let result;
      if (type === 'VP8 ') {
        if (length < 10 || start + 10 > bytes.length || (bytes[start] & 1) ||
            ((bytes[start] >> 1) & 7) > 3 || !(bytes[start] & 16) ||
            bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a ||
            (bytes.readUInt16LE(start + 6) & 0xc000) || (bytes.readUInt16LE(start + 8) & 0xc000)) return null;
        result = metadata('webp', bytes.readUInt16LE(start + 6), bytes.readUInt16LE(start + 8));
      } else {
        if (length < 5 || start + 5 > bytes.length || bytes[start] !== 0x2f) return null;
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29) return null;
        result = metadata('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (!result || (canvas && (canvas.width !== result.width || canvas.height !== result.height))) return null;
      return result;
    } else if (!canvas) {
      return null;
    }
    if (end > bytes.length) return null;
    offset = end;
  }
  return null;
}

function readImageMetadata(url) {
  const source = readDataImage(url);
  if (!source) return null;
  const { bytes, byteLength, format } = source;
  if (format === 'png') return readPng(bytes, byteLength);
  if (format === 'jpeg') return readJpeg(bytes, byteLength);
  if (format === 'webp') return readWebp(bytes, byteLength);
  // GIF needs frame traversal to distinguish static images from animation.
  // A bounded header cannot establish that, so all GIFs use the fallback.
  return null;
}

module.exports = { readImageMetadata };
