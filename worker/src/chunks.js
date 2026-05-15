/**
 * Chunk map and asset registry for the AMP Linux VM.
 *
 * Maps chunk names to their content for inline serving.
 * In production, chunks come from R2/KV; these are
 * inline fallbacks for development and small assets.
 *
 * @fileoverview Chunk registry
 */

// ─── Chunk Size Constants ────────────────────────────────────────────────

export const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk
export const FONT_HEADER_SIZE = 298;
export const TOTAL_DISK_CHUNKS = 6; // For a ~30MB disk image

// ─── Chunk Map ───────────────────────────────────────────────────────────

export const CHUNK_MAP = {
  "v86-wasm": { type: "wasm", desc: "v86 x86 emulator WebAssembly module" },
  "v86-js": { type: "js", desc: "v86 x86 emulator JavaScript bundle" },
  "seabios": { type: "bios", desc: "SeaBIOS firmware" },
  "vgabios": { type: "vga-bios", desc: "VGA BIOS firmware" },
  "bzimage": { type: "kernel", desc: "Linux kernel (bzImage)" },
  "initrd": { type: "initrd", desc: "Initial RAM disk" },
  "disk-0": { type: "disk-chunk", desc: "Disk image chunk 0", index: 0 },
  "disk-1": { type: "disk-chunk", desc: "Disk image chunk 1", index: 1 },
  "disk-2": { type: "disk-chunk", desc: "Disk image chunk 2", index: 2 },
  "disk-3": { type: "disk-chunk", desc: "Disk image chunk 3", index: 3 },
  "disk-4": { type: "disk-chunk", desc: "Disk image chunk 4", index: 4 },
  "disk-5": { type: "disk-chunk", desc: "Disk image chunk 5", index: 5 },
};

// ─── URL Mappings ────────────────────────────────────────────────────────

/**
 * Builds the AMP CDN URL for a chunk.
 * Pattern: https://<publisher>--<worker>-<org>-workers-dev.cdn.ampproject.org/r/s/<worker>.<org>.workers.dev/<chunk>
 */
export function buildAmpUrl(chunkName, config = {}) {
  const {
    publisher = "vm",
    worker = "amp-linux-vm",
    org = "your-org",
  } = config;
  const origin = `${worker}.${org}.workers.dev`;
  const ampHost = `${publisher}--${worker}-${org}-workers-dev.cdn.ampproject.org`;
  return `https://${ampHost}/r/s/${origin}/${chunkName}`;
}

/**
 * Builds the direct Cloudflare Worker URL for a chunk.
 */
export function buildDirectUrl(chunkName, config = {}) {
  const { worker = "amp-linux-vm", org = "your-org" } = config;
  return `https://${worker}.${org}.workers.dev/${chunkName}`;
}

// ─── Required Boot Order ─────────────────────────────────────────────────

/**
 * The order in which v86 loads resources. The critical boot path.
 * Phase 1: WASM + BIOS (loaded first by v86)
 * Phase 2: Kernel + initrd (loaded in parallel)
 * Phase 3: Disk (sector-by-sector as Linux boots)
 */
export const BOOT_ORDER = {
  critical: ["v86-wasm", "v86-js", "seabios", "vgabios"],
  boot: ["bzimage", "initrd"],
  lazy: ["disk-0", "disk-1", "disk-2", "disk-3", "disk-4", "disk-5"],
};

// ─── Chunk Retrieval ─────────────────────────────────────────────────────

/**
 * Gets a chunk by name. In a real deployment this comes from R2/KV.
 * For development, returns null — chunks must be pre-loaded.
 */
export function getChunk(name) {
  // Inline chunks not supported in worker — chunks must be in R2/KV
  // This function exists for potential inline fallback of very small assets
  return null;
}

/**
 * Gets an asset from the registry.
 */
export function getAsset(name) {
  return getChunk(name);
}

// ─── Generate All Chunk URLs ─────────────────────────────────────────────

/**
 * Generates all AMP CDN URLs and direct URLs for all chunks.
 */
export function generateAllUrls(config = {}) {
  const chunkNames = Object.keys(CHUNK_MAP);
  return chunkNames.map((name) => ({
    name,
    type: CHUNK_MAP[name].type,
    desc: CHUNK_MAP[name].desc,
    ampUrl: buildAmpUrl(name, config),
    directUrl: buildDirectUrl(name, config),
  }));
}

export default {
  CHUNK_MAP,
  CHUNK_SIZE,
  FONT_HEADER_SIZE,
  TOTAL_DISK_CHUNKS,
  BOOT_ORDER,
  buildAmpUrl,
  buildDirectUrl,
  generateAllUrls,
  getChunk,
  getAsset,
};
