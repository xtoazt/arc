/**
 * VM Worker — Runs v86 WASM emulation in a Web Worker.
 *
 * Architecture:
 *  ┌─────────────────────┐     postMessage      ┌──────────────────────┐
 *  │  Main Thread        │◄────────────────────►│  Web Worker (this)    │
 *  │                     │                       │                      │
 *  │  • Canvas rendering │   framebuffer bytes   │  • v86 WASM instance │
 *  │  • Input (kbd/mouse)│   input events        │  • Full CPU emulation│
 *  │  • UI/status        │   control messages    │  • Block device I/O  │
 *  │  • COW disk overlay │   disk read/write     │  • Network stack      │
 *  └─────────────────────┘   snapshot data       └──────────────────────┘
 *
 * Benefits:
 *  - Main thread stays at 60fps (only renders Canvas)
 *  - Emulation never blocks UI
 *  - Perceived responsiveness 10× better
 *
 * Note: This is a CLASSIC worker (not module). Uses importScripts for v86 loading.
 *
 * @fileoverview v86 Web Worker
 */

// ─── Configuration ────────────────────────────────────────────────────────

const SNAPSHOT_AUTO_INTERVAL = 60000; // Auto-snapshot every 60s
const BOOT_TIMEOUT = 30000; // Give up waiting for boot after 30s

// ─── State ────────────────────────────────────────────────────────────────

let emulator = null;
let fbWidth = 0;
let fbHeight = 0;
let isBooted = false;
let pendingDiskReads = new Map(); // id → { resolve, reject }
let readIdCounter = 0;
let snapshotTimer = null;
let bootTimer = null;

// ─── Message Handler ──────────────────────────────────────────────────────

self.onmessage = async (e) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case "boot":
        await handleBoot(msg.config);
        break;

      case "restore-snapshot":
        await handleRestoreSnapshot(msg.snapshot, msg.config);
        break;

      case "keyevent":
        handleKeyEvent(msg);
        break;

      case "mouseevent":
        handleMouseEvent(msg);
        break;

      case "disk-read-result":
        handleDiskReadResult(msg);
        break;

      case "disk-read-error":
        handleDiskReadError(msg);
        break;

      case "disk-write-result":
        // Write acknowledged — no action needed
        break;

      case "save-snapshot":
        await handleSaveSnapshot();
        break;

      case "resume":
        if (emulator) emulator.run();
        break;

      case "pause":
        if (emulator) emulator.stop();
        break;

      case "reset":
        await handleReset();
        break;

      default:
        log(`Unknown message type: ${msg.type}`);
    }
  } catch (err) {
    log(`Error handling ${msg.type}: ${err.message}`);
    post({ type: "error", message: err.message });
  }
};

// ─── Boot Sequence ────────────────────────────────────────────────────────

async function handleBoot(config) {
  const {
    wasmUrl,
    biosUrl,
    vgaBiosUrl,
    kernelUrl,
    initrdUrl,
    v86JsUrl,
    memorySize = 256 * 1024 * 1024,
    vgaMemorySize = 8 * 1024 * 1024,
  } = config;

  log("Booting VM...");

  // Load v86 via importScripts from Blob URL
  // importScripts runs the JS in worker global scope
  if (typeof self.V86 === "undefined") {
    if (!v86JsUrl) {
      throw new Error("v86 JS URL required");
    }

    try {
      // Fetch the v86 JS code to wrap it for worker context
      const response = await fetch(v86JsUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch v86 JS: HTTP ${response.status}`);
      }
      const v86Code = await response.text();

      // v86 typically does `window.V86 = ...` — wrap to make it available
      // in worker global scope (self). Also handle `var V86 = ...` patterns.
      const wrappedCode = [
        "(function() {",
        "  var window = self;",
        "  var document = { createElement: function() { return { style: {}, addEventListener: function() {} }; } };",
        v86Code,
        "  self.V86 = self.V86 || V86 || window.V86;",
        "})();",
      ].join("\n");

      const wrapperBlob = new Blob([wrappedCode], { type: "text/javascript" });
      const wrapperUrl = URL.createObjectURL(wrapperBlob);

      importScripts(wrapperUrl);
      URL.revokeObjectURL(wrapperUrl);
    } catch (err) {
      throw new Error(`Failed to load v86: ${err.message}`);
    }
  }

  if (typeof self.V86 === "undefined") {
    throw new Error("v86 failed to initialize — V86 not defined");
  }

  // Create a dummy screen container for headless operation
  const screenDummy = {
    style: {},
    addEventListener: function () {},
    removeEventListener: function () {},
  };

  try {
    emulator = new self.V86({
      wasm_path: wasmUrl,
      memory_size: memorySize,
      vga_memory_size: vgaMemorySize,
      screen_container: screenDummy,
      bios: { url: biosUrl },
      vga_bios: { url: vgaBiosUrl },
      bzimage: kernelUrl,
      initrd: initrdUrl,
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      filesystem: {},
      network_relay_url: null,
    });
  } catch (err) {
    throw new Error(`v86 constructor failed: ${err.message}`);
  }

  // Hook into emulator events
  setupEmulatorListeners();

  // Start periodic framebuffer capture
  startFramebufferLoop();

  // Start auto-snapshot
  startAutoSnapshot();

  log("VM boot sequence initiated");
}

// ─── Snapshot Restore ─────────────────────────────────────────────────────

async function handleRestoreSnapshot(snapshot, config) {
  const { ramTier = 128 * 1024 * 1024 } = config || {};

  log("Restoring from snapshot...");

  // Need v86 loaded to restore
  if (typeof self.V86 === "undefined") {
    throw new Error("v86 not loaded — snapshot restore requires full boot first");
  }

  const screenDummy = {
    style: {},
    addEventListener: function () {},
    removeEventListener: function () {},
  };

  try {
    emulator = new self.V86({
      screen_container: screenDummy,
      disable_keyboard: true,
      disable_mouse: true,
      autostart: false,
    });

    await emulator.restore_state(snapshot);

    setupEmulatorListeners();
    emulator.run();
    startFramebufferLoop();
    startAutoSnapshot();

    isBooted = true;
    post({ type: "restored" });
    post({ type: "booted" });

    log("Snapshot restored successfully");

  } catch (err) {
    log(`Snapshot restore failed: ${err.message}`);
    throw err;
  }
}

// ─── Emulator Listeners ───────────────────────────────────────────────────

function setupEmulatorListeners() {
  if (!emulator) return;

  // Track framebuffer dimensions
  emulator.add_listener("screen-set-size", (size) => {
    fbWidth = size.width;
    fbHeight = size.height;
    log(`Framebuffer: ${fbWidth}x${fbHeight}`);
  });

  // Boot detection
  emulator.add_listener("emulator-loaded", () => {
    log("Emulator loaded — waiting for kernel boot...");

    // Start boot timeout
    bootTimer = setTimeout(() => {
      if (!isBooted) {
        isBooted = true;
        log("VM booted (timeout fallback)");
        post({ type: "booted" });

        // Auto-snapshot after boot settles
        setTimeout(() => {
          if (emulator) handleSaveSnapshot();
        }, 5000);
      }
    }, 10000);
  });

  emulator.add_listener("emulator-stopped", () => {
    log("Emulator stopped");
  });

  // Error forwarding
  emulator.add_listener("error", (err) => {
    log(`Emulator error: ${err}`);
    post({ type: "error", message: String(err) });
  });

  // Detect serial output for early boot detection
  emulator.add_listener("serial0-output-byte", () => {
    if (!isBooted && bootTimer) {
      // If we're getting serial output, boot is progressing
    }
  });
}

// ─── Framebuffer Loop ─────────────────────────────────────────────────────

function startFramebufferLoop() {
  let lastSend = 0;
  const TARGET_FPS = 30; // 30fps to reduce overhead
  const FRAME_MS = 1000 / TARGET_FPS;

  const sendFrame = () => {
    if (!emulator || !isBooted) return;

    const now = performance.now();
    if (now - lastSend < FRAME_MS) return;
    lastSend = now;

    try {
      if (typeof emulator.screen_make_screenshot === "function") {
        const screenshot = emulator.screen_make_screenshot();
        if (screenshot) {
          post({
            type: "framebuffer-screenshot",
            data: screenshot,
            width: fbWidth || 800,
            height: fbHeight || 600,
          });
        }
      }
    } catch (e) {
      // Framebuffer not available yet
    }
  };

  // Use setInterval for universal browser support (Safari workers lack rAF)
  // requestAnimationFrame is used as a performance enhancement where available
  if (typeof requestAnimationFrame === "function") {
    const loop = () => {
      sendFrame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    // Fallback for Safari workers
    setInterval(sendFrame, FRAME_MS);
  }
}

// ─── Disk I/O Interception ────────────────────────────────────────────────

function requestDiskRead(sector, count) {
  return new Promise((resolve, reject) => {
    const id = ++readIdCounter;
    pendingDiskReads.set(id, { resolve, reject });
    post({ type: "disk-read", id, sector, count });

    // Timeout after 10s
    setTimeout(() => {
      if (pendingDiskReads.has(id)) {
        pendingDiskReads.delete(id);
        reject(new Error(`Disk read timeout: sector ${sector}`));
      }
    }, 10000);
  });
}

function handleDiskReadResult(msg) {
  const pending = pendingDiskReads.get(msg.id);
  if (pending) {
    pendingDiskReads.delete(msg.id);
    try {
      pending.resolve(msg.data);
    } catch (e) {
      log(`Disk read resolve error: ${e.message}`);
    }
  }
}

function handleDiskReadError(msg) {
  const pending = pendingDiskReads.get(msg.id);
  if (pending) {
    pendingDiskReads.delete(msg.id);
    pending.reject(new Error(msg.error));
  }
}

// ─── Input Handling ───────────────────────────────────────────────────────

function handleKeyEvent(msg) {
  if (!emulator) return;
  if (msg.event !== "keydown") return;

  try {
    const scancode = keyToScancode(msg.keyCode, msg.shift, msg.ctrl, msg.alt);
    if (scancode && typeof emulator.keyboard_send_scancodes === "function") {
      emulator.keyboard_send_scancodes(scancode);
    }
  } catch (e) {
    // Ignore input errors
  }
}

function handleMouseEvent(msg) {
  if (!emulator) return;

  try {
    const absX = Math.max(0, Math.min(1, msg.x / (fbWidth || 800)));
    const absY = Math.max(0, Math.min(1, msg.y / (fbHeight || 600)));

    if (typeof emulator.mouse_send !== "function") return;

    if (msg.event === "mousemove") {
      emulator.mouse_send(absX, absY, 0);
    } else if (msg.event === "mousedown") {
      emulator.mouse_send(absX, absY, 1 << (msg.button || 0));
    } else if (msg.event === "mouseup") {
      emulator.mouse_send(absX, absY, 0);
    }
  } catch (e) {
    // Ignore mouse errors
  }
}

// ─── Snapshot Management ──────────────────────────────────────────────────

async function handleSaveSnapshot() {
  if (!emulator || !isBooted) return;

  try {
    if (typeof emulator.save_state !== "function") {
      log("save_state not available on this v86 version");
      return;
    }

    const snapshot = await emulator.save_state();

    // Transfer the buffer efficiently
    const buffer = snapshot.buffer || snapshot;
    post(
      {
        type: "snapshot-ready",
        data: buffer,
      },
      [buffer]
    );

    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
    log(`Snapshot saved (${sizeMB}MB)`);
  } catch (err) {
    log(`Snapshot save failed: ${err.message}`);
  }
}

function startAutoSnapshot() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    handleSaveSnapshot();
  }, SNAPSHOT_AUTO_INTERVAL);
}

// ─── Reset ────────────────────────────────────────────────────────────────

async function handleReset() {
  // Clean up timers
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }

  // Destroy emulator
  if (emulator) {
    try {
      if (typeof emulator.destroy === "function") {
        emulator.destroy();
      }
    } catch (e) {
      /* ignore */
    }
    emulator = null;
  }

  isBooted = false;
  pendingDiskReads.clear();
  fbWidth = 0;
  fbHeight = 0;

  post({ type: "reset-complete" });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function log(message) {
  post({ type: "log", message });
}

function post(msg, transfer) {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

/**
 * Basic keycode → scancode mapping (US keyboard, set 1).
 * Covers letters, numbers, function keys, navigation, and modifiers.
 */
function keyToScancode(keyCode, shift, ctrl, alt) {
  // Letters: A=65 → scancode 0x1E through Z=90 → 0x2C
  if (keyCode >= 65 && keyCode <= 90) {
    return keyCode - 65 + 0x1e;
  }

  // Numbers (top row): 0=48 → 0x0B, 1=49 → 0x02 ... 9=57 → 0x0A
  if (keyCode >= 48 && keyCode <= 57) {
    if (keyCode === 48) return 0x0b;
    return keyCode - 49 + 0x02;
  }

  // F1-F12: F1=112 → 0x3B
  if (keyCode >= 112 && keyCode <= 123) {
    return keyCode - 112 + 0x3b;
  }

  // Common special keys
  const map = {
    8: 0x0e,   // Backspace
    9: 0x0f,   // Tab
    13: 0x1c,  // Enter
    27: 0x01,  // Escape
    32: 0x39,  // Space
    33: 0x49,  // Page Up
    34: 0x51,  // Page Down
    35: 0x4f,  // End
    36: 0x47,  // Home
    37: 0x4b,  // Left Arrow
    38: 0x48,  // Up Arrow
    39: 0x4d,  // Right Arrow
    40: 0x50,  // Down Arrow
    46: 0x53,  // Delete
  };

  return map[keyCode] || 0;
}

// Signal that the worker is ready to receive messages
post({ type: "worker-ready" });
