/**
 * Disk Assembler — Concatenates AMP chunks into a complete disk image.
 *
 * Handles:
 *  - Chunk concatenation
 *  - gzip decompression (streaming via DecompressionStream)
 *  - SHA-256 integrity verification
 *  - Memory-efficient progressive assembly
 *
 * @fileoverview Disk image assembly
 */

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Assembles chunks into a single disk image ArrayBuffer.
 *
 * @param {Map<string, ArrayBuffer>} chunks - Map of chunk name → buffer
 * @param {string[]} chunkOrder - Ordered array of chunk names (e.g., ["disk-0", "disk-1", ...])
 * @returns {Promise<ArrayBuffer>} Complete disk image
 */
export async function assembleDisk(chunks, chunkOrder = null) {
  if (!chunkOrder) {
    // Auto-generate order: sort by chunk name
    chunkOrder = [...chunks.keys()]
      .filter((name) => name.startsWith("disk-"))
      .sort((a, b) => {
        const an = parseInt(a.split("-")[1], 10);
        const bn = parseInt(b.split("-")[1], 10);
        return an - bn;
      });
  }

  if (chunkOrder.length === 0) {
    throw new Error("No disk chunks to assemble");
  }

  // Calculate total size
  let totalSize = 0;
  for (const name of chunkOrder) {
    const chunk = chunks.get(name);
    if (!chunk) throw new Error(`Missing chunk: ${name}`);
    totalSize += chunk.byteLength;
  }

  // Concatenate
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const name of chunkOrder) {
    const chunk = new Uint8Array(chunks.get(name));
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result.buffer;
}

/**
 * Decompresses a gzip-compressed disk image using streaming decompression.
 * This avoids memory spikes by not duplicating the compressed data.
 *
 * @param {ArrayBuffer} compressed - The compressed (gzip) data
 * @returns {Promise<ArrayBuffer>} Decompressed data
 */
export async function decompressGzip(compressed) {
  // Use the browser's native DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data and close
  writer.write(new Uint8Array(compressed));
  writer.close();

  // Read all decompressed chunks
  const chunks = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalSize += value.byteLength;
  }

  // Concatenate decompressed chunks
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result.buffer;
}

/**
 * Verifies the SHA-256 hash of a disk image.
 *
 * @param {ArrayBuffer} buffer
 * @param {string} expectedHash - Hex-encoded expected SHA-256
 * @returns {Promise<{ valid: boolean, hash: string }>}
 */
export async function verifyIntegrity(buffer, expectedHash) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    valid: hashHex === expectedHash,
    hash: hashHex,
  };
}

/**
 * Assembles and optionally decompresses chunks.
 *
 * @param {Map<string, ArrayBuffer>} chunks
 * @param {Object} options
 * @param {boolean} options.compressed - Whether chunks are gzip-compressed
 * @param {string} options.expectedHash - Optional SHA-256 hex for verification
 * @returns {Promise<{ buffer: ArrayBuffer, valid: boolean|null, hash: string|null }>}
 */
export async function assembleAndVerify(chunks, options = {}) {
  const { compressed = true, expectedHash = null } = options;

  // Assemble
  let assembled = await assembleDisk(chunks);

  // Decompress if needed
  if (compressed) {
    assembled = await decompressGzip(assembled);
  }

  // Verify if hash provided
  let valid = null;
  let hash = null;
  if (expectedHash) {
    const result = await verifyIntegrity(assembled, expectedHash);
    valid = result.valid;
    hash = result.hash;
    if (!valid) {
      console.error(
        `Disk image integrity FAILED!\n  Expected: ${expectedHash}\n  Got:      ${hash}`
      );
    }
  }

  return { buffer: assembled, valid, hash };
}

export default { assembleDisk, decompressGzip, verifyIntegrity, assembleAndVerify };
