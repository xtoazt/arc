/**
 * VM Boot Orchestrator — Coordinates the full boot sequence:
 *  1. Fetch all chunks from AMP CDN (parallel)
 *  2. Strip font headers
 *  3. Create Blob URLs for v86 resources
 *  4. Assemble disk image
 *  5. Initialize COW overlay
 *  6. Boot v86 in Web Worker
 *  7. Restore snapshot if available (instant boot)
 *
 * Prioritizes AMP CDN for all loading. Origin worker is transparent fallback.
 *
 * @fileoverview VM boot orchestration
 */

import { fetchAllChunks } from './amp-loader.js';
import { assembleAndVerify } from './disk-assembler.js';
import { COWDisk } from './cow-storage.js';
import { saveSnapshot, loadSnapshot, hasSnapshot } from './snapshot.js';

// ─── Constants ───────────────────────────────────────────────────────────

// Chunk names in boot order
const CHUNK_NAMES = [
  // Phase 1: Critical (v86 engine)
  'v86-wasm', 'v86-js', 'seabios', 'vgabios',
  // Phase 2: Boot
  'bzimage', 'initrd',
  // Phase 3: Disk chunks
  'disk-0', 'disk-1', 'disk-2', 'disk-3', 'disk-4', 'disk-5',
];

// RAM sizes by device class
const RAM_TIERS = {
  micro: 64 * 1024 * 1024,   // 64MB
  small: 128 * 1024 * 1024,  // 128MB
  medium: 256 * 1024 * 1024, // 256MB
  large: 512 * 1024 * 1024,  // 512MB
};

// ─── Main API ────────────────────────────────────────────────────────────

/**
 * Boots the VM with the full AMP CDN boot sequence.
 *
 * @param {Object} options
 * @param {HTMLElement} options.screenContainer - Canvas container element
 * @param {Function} options.onProgress - Progress callback (see fetchAllChunks)
 * @param {Function} options.onBooted - Called when VM reaches login prompt
 * @param {Function} options.onError - Called on boot failure
 * @param {boolean} options.useSnapshot - Try to restore snapshot (default: true)
 * @param {AbortSignal} options.signal
 * @returns {Promise<{ emulator: Worker, cowDisk: COWDisk, blobUrls: Map }>}
 */
export async function bootVM(options = {}) {
  const {
    screenContainer,
    onProgress,
    onBooted,
    onError,
    useSnapshot = true,
    signal,
  } = options;

  try {
    // ── Step 0: Try snapshot restore (instant boot) ─────────────────────
    if (useSnapshot && (await hasSnapshot())) {
      const result = await bootFromSnapshot(screenContainer, onProgress, onBooted, onError);
      if (result) return result;
      // If snapshot restore failed, fall through to fresh boot
    }

    // ── Step 1: Fetch all chunks from AMP CDN ───────────────────────────
    if (onProgress) {
      onProgress({ stage: 'fetching', loaded: 0, total: CHUNK_NAMES.length, percent: 0 });
    }

    const chunks = await fetchAllChunks(CHUNK_NAMES, {
      signal,
      onProgress: (info) => {
        if (onProgress) {
          onProgress({
            ...info,
            stage: 'fetching',
          });
        }
      },
      onChunkLoaded: (info) => {
        console.debug(`Loaded: ${info.name} (${(info.size / 1024 / 1024).toFixed(1)}MB)`);
      },
    });

    // ── Step 2: Assemble disk image ─────────────────────────────────────
    if (onProgress) {
      onProgress({ stage: 'assembling', loaded: 0, total: 1, percent: 0 });
    }

    const diskResult = await assembleAndVerify(chunks, {
      compressed: true,
    });

    if (onProgress) {
      onProgress({ stage: 'assembling', loaded: 1, total: 1, percent: 100 });
    }

    // ── Step 3: Initialize COW overlay ─────────────────────────────────
    if (onProgress) {
      onProgress({ stage: 'storage', loaded: 0, total: 1, percent: 0 });
    }

    const cowDisk = new COWDisk(diskResult.buffer);
    await cowDisk.init();

    if (onProgress) {
      onProgress({ stage: 'storage', loaded: 1, total: 1, percent: 100 });
    }

    // ── Step 4: Create Blob URLs for v86 ───────────────────────────────
    if (onProgress) {
      onProgress({ stage: 'preparing', loaded: 0, total: 1, percent: 0 });
    }

    const blobUrls = createBlobUrls(chunks);

    // ── Step 5: Boot v86 in Web Worker ─────────────────────────────────
    const emulator = await bootV86InWorker({
      blobUrls,
      diskBuffer: diskResult.buffer,
      cowDisk,
      screenContainer,
      ramTier: detectRamTier(),
      onBooted,
      onError,
    });

    if (onProgress) {
      onProgress({ stage: 'booting', loaded: 1, total: 1, percent: 100 });
    }

    return { emulator, cowDisk, blobUrls };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// ─── Snapshot Boot ───────────────────────────────────────────────────────

async function bootFromSnapshot(screenContainer, onProgress, onBooted, onError) {
  if (onProgress) {
    onProgress({ stage: 'snapshot', loaded: 0, total: 1, percent: 0 });
  }

  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      // Snapshot not found — signal to do fresh boot
      return null;
    }

    if (onProgress) {
      onProgress({ stage: 'snapshot', loaded: 1, total: 1, percent: 100 });
    }

    // Classic worker (not module) so importScripts works inside
    const worker = new Worker('/js/vm-worker.js');

    // Wait for worker-ready signal
    await new Promise((resolve) => {
      const handler = (e) => {
        if (e.data.type === 'worker-ready') {
          worker.removeEventListener('message', handler);
          resolve();
        }
      };
      worker.addEventListener('message', handler);
    });

    // Snapshot restore doesn't need v86 JS separately —
    // the worker handles it internally via Blob URLs
    worker.postMessage({
      type: 'restore-snapshot',
      snapshot: snapshot,
      config: {
        ramTier: detectRamTier(),
      },
    });

    // Set up framebuffer display
    setupWorkerDisplay(worker, screenContainer);

    return new Promise((resolve) => {
      worker.addEventListener('message', (e) => {
        if (e.data.type === 'restored' || e.data.type === 'booted') {
          onBooted?.({ instant: true });
          resolve({ emulator: worker, cowDisk: null, blobUrls: null });
        } else if (e.data.type === 'error') {
          console.warn('Snapshot restore failed, falling back to fresh boot');
          worker.terminate();
          resolve(null);
        }
      });
    });
  } catch (err) {
    console.warn(`Snapshot boot failed: ${err.message}`);
    return null;
  }
}

// ─── v86 Worker Boot ────────────────────────────────────────────────────

function bootV86InWorker(options) {
  const {
    blobUrls,
    diskBuffer,
    cowDisk,
    screenContainer,
    ramTier,
    onBooted,
    onError,
  } = options;

  return new Promise((resolve, reject) => {
    // Classic worker (not module) — required for importScripts() support
    const worker = new Worker('/js/vm-worker.js');

    // Forward framebuffer to canvas
    setupWorkerDisplay(worker, screenContainer);

    worker.addEventListener('message', (e) => {
      const msg = e.data;

      switch (msg.type) {
        case 'log':
          console.log(`[VM] ${msg.message}`);
          break;

        case 'worker-ready':
          // Send boot config now that worker is ready
          worker.postMessage({
            type: 'boot',
            config: {
              wasmUrl: blobUrls.get('v86-wasm'),
              biosUrl: blobUrls.get('seabios'),
              vgaBiosUrl: blobUrls.get('vgabios'),
              kernelUrl: blobUrls.get('bzimage'),
              initrdUrl: blobUrls.get('initrd'),
              v86JsUrl: blobUrls.get('v86-js'),
              memorySize: ramTier,
              vgaMemorySize: 8 * 1024 * 1024,
            },
          });
          break;

        case 'booted':
          onBooted?.({ instant: false });
          resolve(worker);
          break;

        case 'error':
          onError?.(new Error(msg.message));
          reject(new Error(msg.message));
          break;

        case 'disk-read':
          handleDiskRead(msg, diskBuffer, cowDisk, worker);
          break;

        case 'disk-write':
          handleDiskWrite(msg, cowDisk, worker);
          break;

        case 'snapshot-ready':
          saveSnapshot(msg.data);
          break;

        default:
          break;
      }
    });

    worker.addEventListener('error', (err) => {
      onError?.(err);
      reject(err);
    });
  });
}

// ─── Worker Display Setup ────────────────────────────────────────────────

function setupWorkerDisplay(worker, container) {
  // Create or reuse canvas
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
  }

  const ctx = canvas.getContext('2d', { alpha: false });

  worker.addEventListener('message', (e) => {
    if (e.data.type === 'framebuffer') {
      const { buffer, width, height } = e.data;
      canvas.width = width;
      canvas.height = height;

      const imageData = new ImageData(
        new Uint8ClampedArray(buffer),
        width,
        height
      );
      // Use createImageBitmap for better performance
      createImageBitmap(imageData).then((bitmap) => {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      });
    } else if (e.data.type === 'framebuffer-screenshot') {
      // Handle base64 screenshot from worker (fallback mode)
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
      };
      img.src = e.data.data;
    }
  });

  // Forward keyboard/mouse events
  setupInputForwarding(canvas, worker);
}

// ─── Input Forwarding ────────────────────────────────────────────────────

function setupInputForwarding(canvas, worker) {
  canvas.tabIndex = 0;
  canvas.focus();

  canvas.addEventListener('keydown', (e) => {
    e.preventDefault();
    worker.postMessage({
      type: 'keyevent',
      event: 'keydown',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
    });
  });

  canvas.addEventListener('keyup', (e) => {
    e.preventDefault();
    worker.postMessage({
      type: 'keyevent',
      event: 'keyup',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
    });
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    worker.postMessage({
      type: 'mouseevent',
      event: 'mousemove',
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  });

  canvas.addEventListener('mousedown', (e) => {
    worker.postMessage({
      type: 'mouseevent',
      event: 'mousedown',
      button: e.button,
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    worker.postMessage({
      type: 'mouseevent',
      event: 'mouseup',
      button: e.button,
    });
  });
}

// ─── Disk I/O Handlers ──────────────────────────────────────────────────

function handleDiskRead(msg, diskBuffer, cowDisk, worker) {
  try {
    const data = cowDisk
      ? cowDisk.read(msg.sector, msg.count)
      : diskBuffer.slice(
          msg.sector * 512,
          (msg.sector + msg.count) * 512
        );
    worker.postMessage(
      {
        type: 'disk-read-result',
        id: msg.id,
        data,
      },
      [data]
    );
  } catch (err) {
    worker.postMessage({
      type: 'disk-read-error',
      id: msg.id,
      error: err.message,
    });
  }
}

function handleDiskWrite(msg, cowDisk, worker) {
  try {
    if (cowDisk) {
      cowDisk.write(msg.sector, msg.data);
    }
    worker.postMessage({
      type: 'disk-write-result',
      id: msg.id,
      ok: true,
    });
  } catch (err) {
    worker.postMessage({
      type: 'disk-write-error',
      id: msg.id,
      error: err.message,
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function createBlobUrls(chunks) {
  const mimeTypes = {
    'v86-wasm': 'application/wasm',
    'v86-js': 'text/javascript',
    'seabios': 'application/octet-stream',
    'vgabios': 'application/octet-stream',
    'bzimage': 'application/octet-stream',
    'initrd': 'application/octet-stream',
  };

  const urls = new Map();
  for (const [name, buffer] of chunks) {
    const mime = mimeTypes[name] || 'application/octet-stream';
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    urls.set(name, url);
  }
  return urls;
}

export function detectRamTier() {
  const deviceRam = navigator.deviceMemory || 4; // GB
  if (deviceRam < 2) return RAM_TIERS.micro;
  if (deviceRam < 4) return RAM_TIERS.small;
  if (deviceRam < 8) return RAM_TIERS.medium;
  return RAM_TIERS.large;
}
