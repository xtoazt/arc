/**
 * Font Header utility — client-side version.
 *
 * Contains the 298-byte minimal TrueType font binary data
 * and utilities for stripping font headers from AMP CDN responses.
 *
 * @fileoverview Font header client utility
 */

/** The exact 298-byte TrueType font in hex */
const FONT_HEX =
  "00010000000a0080000300204f532f3269f96f2b0000013400000056636d" +
  "6170000b00730000018c00000034676c796600000000000000ac00000001" +
  "6865616427594c4f000000d400000036686865610d9f076e000001100000" +
  "0024686d7478028b00000000010c000000046c6f636100000000000000d0" +
  "000000046d617870004103c1000000b0000000206e616d65000600000000" +
  "01c000000006706f7374ffdb005a000001c8000000200000000000010000" +
  "00010354002b0068000c0001000000000000000000000000000800040000" +
  "00000001000000025eb8624511a85f0f3cf5001f080000000000e0fad139" +
  "00000000e0fad139f7d6fc4c0e5909dc000000080002000000000000028b" +
  "000000010000076dfe1d00000efef7d6fa510e5900010000000000000000" +
  "00000000000000010001040e019000050000053305990000011e05330599" +
  "000003d7006602120000020b060303080402020400000001000000000000" +
  "000000000000506645640040002000200614fe14019a076d01e300000001" +
  "000000000000000000020000000300000014000300010000001400040020" +
  "000000040004000100000020ffff00000020ffffffe00001000000000000" +
  "0000000600000003000000000000ffd8005a000000000000000000000000" +
  "0000000000000000";

/** Exact size of the font header in bytes */
export const FONT_HEADER_SIZE = 298;

/** Cached font binary */
let _fontBytes = null;

/**
 * Returns the 298-byte minimal TrueType font as a Uint8Array.
 */
export function getFontHeader() {
  if (!_fontBytes) {
    const len = FONT_HEX.length / 2;
    _fontBytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      _fontBytes[i] = parseInt(FONT_HEX.substr(i * 2, 2), 16);
    }
  }
  return _fontBytes;
}

/**
 * Strips the font header from an ArrayBuffer, returning only the payload.
 * Validates the TrueType magic bytes.
 *
 * @param {ArrayBuffer} buffer - The full buffer (font + payload)
 * @returns {ArrayBuffer} The payload without font header
 */
export function stripFontHeader(buffer) {
  if (buffer.byteLength < FONT_HEADER_SIZE) {
    throw new Error(
      `Buffer too small: ${buffer.byteLength} < ${FONT_HEADER_SIZE}`
    );
  }

  const arr = new Uint8Array(buffer);

  // Verify TrueType magic: sfVersion = 0x00010000
  const magic = arr[0] === 0x00 && arr[1] === 0x01 && arr[2] === 0x00 && arr[3] === 0x00;
  if (!magic) {
    console.warn(
      `Font magic missing for buffer (first 4 bytes: ${Array.from(arr.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")})`
    );
  }

  return buffer.slice(FONT_HEADER_SIZE);
}

export default { FONT_HEADER_SIZE, getFontHeader, stripFontHeader };
