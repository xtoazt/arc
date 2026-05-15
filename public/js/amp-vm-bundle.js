/**
 * AMP Linux VM — Bundled (no ES modules)
 *
 * All modules concatenated for use in classic <script> tags (SVG, plain HTML).
 * Uses a global `AMP` namespace instead of import/export.
 *
 * Architecture (main-thread, no worker):
 *   v86 WASM runs on main thread with requestAnimationFrame-based
 *   framebuffer rendering to keep UI responsive.
 *
 * Dependency order:
 *   1. Font header
 *   2. AMP CDN loader
 *   3. Disk assembler
 *   4. COW storage
 *   5. Snapshot manager
 *   6. VM boot (main-thread v86)
 *
 * @fileoverview Bundled VM for SVG/classic-script contexts
 */
(function () {
  "use strict";

  // ─── Global namespace ────────────────────────────────────────────────
  const AMP = {};
  window.AMP = AMP;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 1: Font Header
  // ═══════════════════════════════════════════════════════════════════════

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

  const FONT_HEADER_SIZE = 298;
  let _fontBytes = null;

  function getFontHeader() {
    if (!_fontBytes) {
      const len = FONT_HEX.length / 2;
      _fontBytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        _fontBytes[i] = parseInt(FONT_HEX.substr(i * 2, 2), 16);
      }
    }
    return _fontBytes;
  }

  function stripFontHeader(buffer) {
    if (buffer.byteLength < FONT_HEADER_SIZE) {
      throw new Error("Buffer too small: " + buffer.byteLength + " < " + FONT_HEADER_SIZE);
    }
    return buffer.slice(FONT_HEADER_SIZE);
  }

  AMP.FONT_HEADER_SIZE = FONT_HEADER_SIZE;
  AMP.getFontHeader = getFontHeader;
  AMP.stripFontHeader = stripFontHeader;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 2: AMP CDN Loader
  // ═══════════════════════════════════════════════════════════════════════

  // Configuration
  const AMP_BASE =
    "https://vm--amp-linux-vm-rohan-workers-dev.cdn.ampproject.org/r/s/amp-linux-vm.rohan.workers.dev";
  const ORIGIN_BASE = "https://amp-linux-vm.rohan.workers.dev";
  const PROXY_PREFIX = "proxy";
  const FETCH_TIMEOUT = 15000;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function combineSignals(sig1, sig2) {
    const controller = new AbortController();
    sig1.addEventListener("abort", function () {
      controller.abort(sig1.reason);
    });
    sig2.addEventListener("abort", function () {
      controller.abort(sig2.reason);
    });
    return controller.signal;
  }

  function fetchWithRetry(url, signal) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(function () {
          controller.abort();
        }, FETCH_TIMEOUT);

        const combinedSignal = signal
          ? combineSignals(signal, controller.signal)
          : controller.signal;

        return fetch(url, {
          signal: combinedSignal,
          headers: { Accept: "application/octet-stream" },
        }).then(function (response) {
          clearTimeout(timeoutId);
          if (!response.ok) {
            throw new Error("HTTP " + response.status + ": " + response.statusText);
          }
          return response.arrayBuffer();
        }).then(function (fullBuffer) {
          return stripFontHeader(fullBuffer);
        });
      } catch (err) {
        lastError = err;
        if (err.name === "AbortError") throw err;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
          console.warn("Retry " + attempt + "/" + MAX_RETRIES + " for " + url + " in " + delay + "ms...");
          // Synchronous sleep via spin isn't possible; we use async
          // But since this is in a loop with await... actually we need to restructure
        }
      }
    }
    throw lastError || new Error("Failed after " + MAX_RETRIES + " retries: " + url);
  }

  // Async version with proper retry
  async function fetchWithRetryAsync(url, signal) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(function () {
          controller.abort();
        }, FETCH_TIMEOUT);
        const combinedSignal = signal
          ? combineSignals(signal, controller.signal)
          : controller.signal;

        const response = await fetch(url, {
          signal: combinedSignal,
          headers: { Accept: "application/octet-stream" },
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error("HTTP " + response.status + ": " + response.statusText);
        }
        const fullBuffer = await response.arrayBuffer();
        return stripFontHeader(fullBuffer);
      } catch (err) {
        lastError = err;
        if (err.name === "AbortError") throw err;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
          console.warn("Retry " + attempt + "/" + MAX_RETRIES + " for " + url + " in " + delay + "ms...");
          await sleep(delay);
        }
      }
    }
    throw lastError || new Error("Failed after " + MAX_RETRIES + " retries: " + url);
  }

  async function fetchChunkWithFallback(name, signal) {
    // Try AMP CDN first
    try {
      return await fetchWithRetryAsync(AMP_BASE + "/" + name, signal);
    } catch (ampErr) {
      console.warn("AMP CDN failed for " + name + ": " + ampErr.message + ", trying origin...");
    }
    // Fallback to origin
    try {
      return await fetchWithRetryAsync(ORIGIN_BASE + "/" + name, signal);
    } catch (originErr) {
      console.error("All sources failed for " + name + ": " + originErr.message);
      throw new Error("Failed to load chunk: " + name);
    }
  }

  async function fetchAllChunks(chunkNames, options) {
    options = options || {};
    const onProgress = options.onProgress;
    const onChunkLoaded = options.onChunkLoaded;
    const signal = options.signal;

    const results = new Map();
    let completed = 0;
    const total = chunkNames.length;

    function reportProgress(name) {
      completed++;
      const percent = Math.round((completed / total) * 100);
      if (onProgress) {
        onProgress({ name: name, loaded: completed, total: total, percent: percent });
      }
    }

    const promises = chunkNames.map(async function (name) {
      const buffer = await fetchChunkWithFallback(name, signal);
      results.set(name, buffer);
      if (onChunkLoaded) {
        onChunkLoaded({ name: name, size: buffer.byteLength });
      }
      reportProgress(name);
      return { name: name, buffer: buffer };
    });

    await Promise.all(promises);
    return results;
  }

  async function proxyUrl(targetUrl, options) {
    options = options || {};
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body;
    const signal = options.signal;

    const encoded = btoa(targetUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const proxyPath = AMP_BASE + "/" + PROXY_PREFIX + "/" + encoded;
    const proxyHeaders = new Headers({
      Accept: "application/octet-stream",
      "X-Proxy-Method": method,
      "X-Proxy-Headers": JSON.stringify(headers),
    });

    try {
      const response = await fetch(proxyPath, {
        method: body ? "POST" : "GET",
        headers: proxyHeaders,
        body: body || undefined,
        signal: signal,
      });
      if (!response.ok) {
        throw new Error("Proxy error: HTTP " + response.status);
      }
      const fullBuffer = await response.arrayBuffer();
      const cleanBuffer = fullBuffer.slice(FONT_HEADER_SIZE);
      const contentType = response.headers.get("Content-Type") || "application/octet-stream";
      return new Response(cleanBuffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "X-Proxied-By": "AMP-CDN",
        },
      });
    } catch (ampErr) {
      console.warn("AMP proxy failed for " + targetUrl + ": " + ampErr.message);
      try {
        const originProxyPath = ORIGIN_BASE + "/" + PROXY_PREFIX + "/" + encoded;
        const response = await fetch(originProxyPath, {
          method: body ? "POST" : "GET",
          headers: proxyHeaders,
          body: body || undefined,
          signal: signal,
        });
        return response;
      } catch (originErr) {
        console.error("Proxy failed for " + targetUrl + ": " + originErr.message);
        throw new Error("Failed to proxy: " + targetUrl);
      }
    }
  }

  AMP.fetchAllChunks = fetchAllChunks;
  AMP.fetchChunkWithFallback = fetchChunkWithFallback;
  AMP.proxyUrl = proxyUrl;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 3: Disk Assembler
  // ═══════════════════════════════════════════════════════════════════════

  async function assembleDisk(chunks, chunkOrder) {
    if (!chunkOrder) {
      chunkOrder = [];
      chunks.forEach(function (_, name) {
        if (name.indexOf("disk-") === 0) {
          chunkOrder.push(name);
        }
      });
      chunkOrder.sort(function (a, b) {
        const an = parseInt(a.split("-")[1], 10);
        const bn = parseInt(b.split("-")[1], 10);
        return an - bn;
      });
    }

    if (chunkOrder.length === 0) {
      throw new Error("No disk chunks to assemble");
    }

    let totalSize = 0;
    for (let i = 0; i < chunkOrder.length; i++) {
      const chunk = chunks.get(chunkOrder[i]);
      if (!chunk) throw new Error("Missing chunk: " + chunkOrder[i]);
      totalSize += chunk.byteLength;
    }

    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (let i = 0; i < chunkOrder.length; i++) {
      const chunk = new Uint8Array(chunks.get(chunkOrder[i]));
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result.buffer;
  }

  async function decompressGzip(compressed) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(new Uint8Array(compressed));
    writer.close();

    const chunks_out = [];
    let totalSize = 0;
    while (true) {
      const readResult = await reader.read();
      if (readResult.done) break;
      chunks_out.push(readResult.value);
      totalSize += readResult.value.byteLength;
    }

    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (let i = 0; i < chunks_out.length; i++) {
      result.set(chunks_out[i], offset);
      offset += chunks_out[i].byteLength;
    }

    return result.buffer;
  }

  async function assembleAndVerify(chunks, options) {
    options = options || {};
    const compressed = options.compressed !== false;

    let assembled = await assembleDisk(chunks);

    if (compressed) {
      assembled = await decompressGzip(assembled);
    }

    return { buffer: assembled, valid: null, hash: null };
  }

  AMP.assembleDisk = assembleDisk;
  AMP.assembleAndVerify = assembleAndVerify;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 4: COW Storage
  // ═══════════════════════════════════════════════════════════════════════

  const SECTOR_SIZE = 512;
  const COW_DB_NAME = "amp-linux-vm-cow";
  const COW_DB_VERSION = 1;
  const COW_STORE_NAME = "sectors";
  const FLUSH_INTERVAL = 5000;
  const MAX_DIRTY_SECTORS = 500;

  function COWDisk(baseImage) {
    this.base = baseImage;
    this.overlay = new Map();
    this.dirty = new Set();
    this.db = null;
    this._flushTimer = null;
    this._ready = false;
  }

  COWDisk.prototype.init = async function () {
    const self = this;
    self.db = await openCOWDatabase();

    const persisted = await loadAllSectors(self.db);
    persisted.forEach(function (data, sectorNum) {
      self.overlay.set(sectorNum, data);
    });

    self._flushTimer = setInterval(function () {
      self.flush();
    }, FLUSH_INTERVAL);
    self._ready = true;

    console.log(
      "COW overlay initialized: " +
        persisted.size +
        " persisted sectors (" +
        ((persisted.size * SECTOR_SIZE) / (1024 * 1024)).toFixed(1) +
        "MB)"
    );
  };

  COWDisk.prototype.read = function (sector, count) {
    if (!this._ready) throw new Error("COW overlay not initialized");
    count = count || 1;
    const result = new Uint8Array(count * SECTOR_SIZE);

    for (let i = 0; i < count; i++) {
      const sectorNum = sector + i;
      const offset = i * SECTOR_SIZE;
      if (this.overlay.has(sectorNum)) {
        result.set(this.overlay.get(sectorNum), offset);
      } else {
        const baseOffset = sectorNum * SECTOR_SIZE;
        if (baseOffset + SECTOR_SIZE <= this.base.byteLength) {
          result.set(new Uint8Array(this.base.slice(baseOffset, baseOffset + SECTOR_SIZE)), offset);
        }
      }
    }
    return result.buffer;
  };

  COWDisk.prototype.write = function (sector, data) {
    if (!this._ready) throw new Error("COW overlay not initialized");
    const arr = new Uint8Array(data);
    const count = Math.ceil(arr.length / SECTOR_SIZE);

    for (let i = 0; i < count; i++) {
      const sectorNum = sector + i;
      const sOffset = i * SECTOR_SIZE;
      const sectorData = arr.slice(sOffset, Math.min(sOffset + SECTOR_SIZE, arr.length));
      const padded = new Uint8Array(SECTOR_SIZE);
      padded.set(sectorData);
      this.overlay.set(sectorNum, padded);
      this.dirty.add(sectorNum);
    }

    if (this.dirty.size >= MAX_DIRTY_SECTORS) {
      this.flush();
    }
  };

  COWDisk.prototype.flush = async function () {
    if (!this.db || this.dirty.size === 0) return;
    const toFlush = Array.from(this.dirty);
    const tx = this.db.transaction(COW_STORE_NAME, "readwrite");
    const store = tx.objectStore(COW_STORE_NAME);

    for (let i = 0; i < toFlush.length; i++) {
      store.put(this.overlay.get(toFlush[i]), toFlush[i]);
    }

    await new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = function () {
        reject(tx.error);
      };
    });

    this.dirty.clear();
    console.debug("Flushed " + toFlush.length + " sectors to IndexedDB");
  };

  COWDisk.prototype.destroy = async function () {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
    }
    await this.flush();
    this.overlay.clear();
    this.dirty.clear();
    this._ready = false;
  };

  function openCOWDatabase() {
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(COW_DB_NAME, COW_DB_VERSION);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(COW_STORE_NAME)) {
          db.createObjectStore(COW_STORE_NAME);
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  function loadAllSectors(db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(COW_STORE_NAME, "readonly");
      const store = tx.objectStore(COW_STORE_NAME);
      const request = store.getAllKeys();
      const sectors = new Map();

      request.onsuccess = async function () {
        const keys = request.result;
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const dataRequest = store.get(key);
          await new Promise(function (r) {
            dataRequest.onsuccess = function () {
              sectors.set(key, new Uint8Array(dataRequest.result));
              r();
            };
          });
        }
        resolve(sectors);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  AMP.COWDisk = COWDisk;
  AMP.SECTOR_SIZE = SECTOR_SIZE;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 5: Snapshot Manager
  // ═══════════════════════════════════════════════════════════════════════

  const SNAP_DB_NAME = "amp-linux-vm-snapshots";
  const SNAP_DB_VERSION = 1;
  const SNAP_STORE_NAME = "snapshots";
  const SNAPSHOT_KEY = "booted-state";

  function openSnapDatabase() {
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(SNAP_DB_NAME, SNAP_DB_VERSION);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(SNAP_STORE_NAME)) {
          db.createObjectStore(SNAP_STORE_NAME);
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
      request.onblocked = function () {
        console.warn("Snapshot DB blocked — closing stale connections");
        if (request.result) request.result.close();
      };
    });
  }

  async function saveSnapshot(snapshotData) {
    const db = await openSnapDatabase();
    const data =
      snapshotData instanceof Uint8Array ? snapshotData : new Uint8Array(snapshotData);

    return new Promise(function (resolve, reject) {
      const tx = db.transaction(SNAP_STORE_NAME, "readwrite");
      const store = tx.objectStore(SNAP_STORE_NAME);
      store.put(data, SNAPSHOT_KEY);
      tx.oncomplete = function () {
        db.close();
        console.log("Snapshot saved: " + (data.byteLength / 1024 / 1024).toFixed(1) + "MB");
        resolve();
      };
      tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function loadSnapshot() {
    const db = await openSnapDatabase();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(SNAP_STORE_NAME, "readonly");
      const store = tx.objectStore(SNAP_STORE_NAME);
      const request = store.get(SNAPSHOT_KEY);
      request.onsuccess = function () {
        db.close();
        const result = request.result;
        if (result) {
          console.log(
            "Snapshot loaded: " + (result.byteLength / 1024 / 1024).toFixed(1) + "MB"
          );
          resolve(result instanceof Uint8Array ? result : new Uint8Array(result));
        } else {
          resolve(null);
        }
      };
      request.onerror = function () {
        db.close();
        reject(request.error);
      };
    });
  }

  async function hasSnapshot() {
    const db = await openSnapDatabase();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(SNAP_STORE_NAME, "readonly");
      const store = tx.objectStore(SNAP_STORE_NAME);
      const request = store.count(SNAPSHOT_KEY);
      request.onsuccess = function () {
        db.close();
        resolve(request.result > 0);
      };
      request.onerror = function () {
        db.close();
        reject(request.error);
      };
    });
  }

  async function deleteSnapshot() {
    const db = await openSnapDatabase();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(SNAP_STORE_NAME, "readwrite");
      const store = tx.objectStore(SNAP_STORE_NAME);
      store.delete(SNAPSHOT_KEY);
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    });
  }

  AMP.saveSnapshot = saveSnapshot;
  AMP.loadSnapshot = loadSnapshot;
  AMP.hasSnapshot = hasSnapshot;
  AMP.deleteSnapshot = deleteSnapshot;

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 6: VM Boot — Main Thread v86
  // ═══════════════════════════════════════════════════════════════════════

  const CHUNK_NAMES = [
    "v86-wasm",
    "v86-js",
    "seabios",
    "vgabios",
    "bzimage",
    "initrd",
    "disk-0",
    "disk-1",
    "disk-2",
    "disk-3",
    "disk-4",
    "disk-5",
  ];

  const RAM_TIERS = {
    micro: 64 * 1024 * 1024,
    small: 128 * 1024 * 1024,
    medium: 256 * 1024 * 1024,
    large: 512 * 1024 * 1024,
  };

  function detectRamTier() {
    const deviceRam = navigator.deviceMemory || 4;
    if (deviceRam < 2) return RAM_TIERS.micro;
    if (deviceRam < 4) return RAM_TIERS.small;
    if (deviceRam < 8) return RAM_TIERS.medium;
    return RAM_TIERS.large;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  function createBlobUrls(chunks) {
    const mimeTypes = {
      "v86-wasm": "application/wasm",
      "v86-js": "text/javascript",
      seabios: "application/octet-stream",
      vgabios: "application/octet-stream",
      bzimage: "application/octet-stream",
      initrd: "application/octet-stream",
    };

    const urls = new Map();
    chunks.forEach(function (buffer, name) {
      const mime = mimeTypes[name] || "application/octet-stream";
      const blob = new Blob([buffer], { type: mime });
      urls.set(name, URL.createObjectURL(blob));
    });
    return urls;
  }

  /**
   * Boots v86 on the main thread (no worker).
   * Uses requestAnimationFrame for framebuffer rendering to keep UI responsive.
   */
  async function bootVM(options) {
    options = options || {};
    const screenContainer = options.screenContainer;
    const onProgress = options.onProgress;
    const onBooted = options.onBooted;
    const onError = options.onError;
    const useSnapshot = options.useSnapshot !== false;
    const signal = options.signal;

    try {
      // Step 0: Try snapshot restore
      if (useSnapshot && (await hasSnapshot())) {
        const snapResult = await bootFromSnapshot(screenContainer, onProgress, onBooted, onError);
        if (snapResult) return snapResult;
      }

      // Step 1: Fetch all chunks
      if (onProgress) {
        onProgress({ stage: "fetching", loaded: 0, total: CHUNK_NAMES.length, percent: 0 });
      }

      const chunks = await fetchAllChunks(CHUNK_NAMES, {
        signal: signal,
        onProgress: function (info) {
          if (onProgress) onProgress({ stage: "fetching", loaded: info.loaded, total: info.total, percent: info.percent });
        },
        onChunkLoaded: function (info) {
          console.debug("Loaded: " + info.name + " (" + (info.size / 1024 / 1024).toFixed(1) + "MB)");
        },
      });

      // Step 2: Assemble disk
      if (onProgress) {
        onProgress({ stage: "assembling", loaded: 0, total: 1, percent: 0 });
      }

      const diskResult = await assembleAndVerify(chunks, { compressed: true });

      if (onProgress) {
        onProgress({ stage: "assembling", loaded: 1, total: 1, percent: 100 });
      }

      // Step 3: Init COW
      if (onProgress) {
        onProgress({ stage: "storage", loaded: 0, total: 1, percent: 0 });
      }

      const cowDisk = new COWDisk(diskResult.buffer);
      await cowDisk.init();

      if (onProgress) {
        onProgress({ stage: "storage", loaded: 1, total: 1, percent: 100 });
      }

      // Step 4: Create Blob URLs
      if (onProgress) {
        onProgress({ stage: "preparing", loaded: 0, total: 1, percent: 0 });
      }

      const blobUrls = createBlobUrls(chunks);

      // Step 5: Load v86 JS
      if (onProgress) {
        onProgress({ stage: "loading-v86", loaded: 0, total: 1, percent: 0 });
      }

      await loadV86Script(blobUrls.get("v86-js"));

      if (onProgress) {
        onProgress({ stage: "booting", loaded: 0, total: 1, percent: 0 });
      }

      // Step 6: Create v86 instance on main thread
      const emulator = await createV86Instance({
        wasmUrl: blobUrls.get("v86-wasm"),
        biosUrl: blobUrls.get("seabios"),
        vgaBiosUrl: blobUrls.get("vgabios"),
        kernelUrl: blobUrls.get("bzimage"),
        initrdUrl: blobUrls.get("initrd"),
        memorySize: detectRamTier(),
        vgaMemorySize: 8 * 1024 * 1024,
        screenContainer: screenContainer,
      });

      if (onProgress) {
        onProgress({ stage: "booting", loaded: 1, total: 1, percent: 100 });
      }

      // Set up framebuffer rendering
      startFramebufferLoop(emulator, screenContainer);

      // Set up input forwarding
      setupMainThreadInput(emulator, screenContainer);

      // Set up auto-snapshot
      startAutoSnapshotMain(emulator);

      // Wait for boot
      await waitForBoot(emulator, onBooted);

      return { emulator: emulator, cowDisk: cowDisk, blobUrls: blobUrls };
    } catch (err) {
      if (onError) onError(err);
      throw err;
    }
  }

  // ─── Snapshot Boot ──────────────────────────────────────────────────

  async function bootFromSnapshot(screenContainer, onProgress, onBooted, onError) {
    if (onProgress) {
      onProgress({ stage: "snapshot", loaded: 0, total: 1, percent: 0 });
    }

    try {
      const snapshot = await loadSnapshot();
      if (!snapshot) return null;

      if (onProgress) {
        onProgress({ stage: "snapshot", loaded: 1, total: 1, percent: 100 });
      }

      // Create minimal v86 for restore
      const emulator = new window.V86({
        screen_container: screenContainer,
        disable_keyboard: true,
        disable_mouse: true,
        autostart: false,
      });

      await emulator.restore_state(snapshot);
      emulator.run();

      startFramebufferLoop(emulator, screenContainer);
      setupMainThreadInput(emulator, screenContainer);
      startAutoSnapshotMain(emulator);

      if (onBooted) onBooted({ instant: true });
      return { emulator: emulator, cowDisk: null, blobUrls: null };
    } catch (err) {
      console.warn("Snapshot restore failed: " + err.message);
      return null;
    }
  }

  // ─── v86 Script Loading ─────────────────────────────────────────────

  async function loadV86Script(jsUrl) {
    if (window.V86) return;

    // Fetch and eval — works in SVG context where <script> creation may fail
    const response = await fetch(jsUrl);
    if (!response.ok) {
      throw new Error("Failed to fetch v86 JS: HTTP " + response.status);
    }
    const v86Code = await response.text();

    // Execute v86 in current context
    // v86 typically does `window.V86 = ...` or `var V86 = ...`
    eval(v86Code);

    // Some builds do `window.V86`, others do `var V86` at top level
    if (!window.V86 && typeof V86 !== "undefined") {
      window.V86 = V86;
    }

    if (!window.V86) {
      throw new Error("v86 loaded but V86 not defined");
    }
  }

  // ─── v86 Instance Creation ──────────────────────────────────────────

  async function createV86Instance(config) {
    if (!window.V86) {
      throw new Error("v86 not loaded");
    }

    const emulator = new window.V86({
      wasm_path: config.wasmUrl,
      memory_size: config.memorySize,
      vga_memory_size: config.vgaMemorySize,
      screen_container: config.screenContainer,
      bios: { url: config.biosUrl },
      vga_bios: { url: config.vgaBiosUrl },
      bzimage: config.kernelUrl,
      initrd: config.initrdUrl,
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      filesystem: {},
      network_relay_url: null,
    });

    return emulator;
  }

  // ─── Framebuffer Loop (main thread, requestAnimationFrame) ──────────

  function startFramebufferLoop(emulator, container) {
    let canvas = container.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      container.appendChild(canvas);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.imageRendering = "pixelated";
    }

    const ctx = canvas.getContext("2d", { alpha: false });

    function renderFrame() {
      if (!emulator) return;

      try {
        if (typeof emulator.screen_make_screenshot === "function") {
          const screenshot = emulator.screen_make_screenshot();
          if (screenshot) {
            const img = new Image();
            img.onload = function () {
              canvas.width = img.width;
              canvas.height = img.height;
              ctx.drawImage(img, 0, 0);
            };
            img.src = screenshot;
          }
        }
      } catch (e) {
        // Framebuffer not ready
      }

      requestAnimationFrame(renderFrame);
    }

    requestAnimationFrame(renderFrame);
  }

  // ─── Input Forwarding ───────────────────────────────────────────────

  function setupMainThreadInput(emulator, container) {
    container.tabIndex = 0;
    container.focus();

    container.addEventListener("keydown", function (e) {
      e.preventDefault();
      if (!emulator) return;
      const scancode = keyToScancodeMain(e.keyCode, e.shiftKey, e.ctrlKey, e.altKey);
      if (scancode && typeof emulator.keyboard_send_scancodes === "function") {
        emulator.keyboard_send_scancodes(scancode);
      }
    });

    container.addEventListener("mousemove", function (e) {
      if (!emulator || typeof emulator.mouse_send !== "function") return;
      const rect = container.getBoundingClientRect();
      const absX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const absY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      emulator.mouse_send(absX, absY, 0);
    });

    container.addEventListener("mousedown", function (e) {
      if (!emulator || typeof emulator.mouse_send !== "function") return;
      const rect = container.getBoundingClientRect();
      const absX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const absY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      emulator.mouse_send(absX, absY, 1 << (e.button || 0));
    });

    container.addEventListener("mouseup", function (e) {
      if (!emulator || typeof emulator.mouse_send !== "function") return;
      const rect = container.getBoundingClientRect();
      const absX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const absY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      emulator.mouse_send(absX, absY, 0);
    });
  }

  // ─── Key to Scancode ────────────────────────────────────────────────

  function keyToScancodeMain(keyCode, shift, ctrl, alt) {
    if (keyCode >= 65 && keyCode <= 90) return keyCode - 65 + 0x1e;
    if (keyCode >= 48 && keyCode <= 57) {
      if (keyCode === 48) return 0x0b;
      return keyCode - 49 + 0x02;
    }
    if (keyCode >= 112 && keyCode <= 123) return keyCode - 112 + 0x3b;

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
      37: 0x4b,  // Left
      38: 0x48,  // Up
      39: 0x4d,  // Right
      40: 0x50,  // Down
      46: 0x53,  // Delete
    };
    return map[keyCode] || 0;
  }

  // ─── Auto-Snapshot ──────────────────────────────────────────────────

  function startAutoSnapshotMain(emulator) {
    setInterval(async function () {
      if (!emulator) return;
      try {
        if (typeof emulator.save_state === "function") {
          const snapshot = await emulator.save_state();
          await saveSnapshot(snapshot);
        }
      } catch (e) {
        console.warn("Auto-snapshot failed: " + e.message);
      }
    }, 60000);
  }

  // ─── Boot Detection ─────────────────────────────────────────────────

  function waitForBoot(emulator, onBooted) {
    return new Promise(function (resolve) {
      let booted = false;

      emulator.add_listener("emulator-loaded", function () {
        console.log("Emulator loaded — waiting for boot...");
        // Give it time to boot
        setTimeout(function () {
          if (!booted) {
            booted = true;
            console.log("VM booted (timeout fallback)");
            if (onBooted) onBooted({ instant: false });
            resolve();

            // Auto-snapshot after boot settles
            setTimeout(async function () {
              try {
                if (typeof emulator.save_state === "function") {
                  const snapshot = await emulator.save_state();
                  await saveSnapshot(snapshot);
                }
              } catch (e) {
                // ignore
              }
            }, 5000);
          }
        }, 10000);
      });

      emulator.add_listener("error", function (err) {
        console.error("Emulator error: " + err);
      });
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────

  AMP.bootVM = bootVM;
  AMP.detectRamTier = detectRamTier;
  AMP.formatBytes = formatBytes;
  AMP.formatDuration = formatDuration;
  AMP.CHUNK_NAMES = CHUNK_NAMES;

})();
