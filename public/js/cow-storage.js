/**
 * Copy-on-Write (COW) Storage Overlay — Persistent VM storage via IndexedDB.
 *
 * Architecture:
 *   ┌──────────────┐  ┌──────────────────────┐
 *   │  Base image   │  │  COW overlay (this)   │
 *   │  (AMP CDN)    │  │  (IndexedDB, local)   │
 *   │  Read-only    │  │  Read/Write           │
 *   └──────────────┘  └──────────────────────┘
 *
 * Read:  If sector in overlay → use overlay
 *        Else → use base image
 * Write: Always write to overlay
 *
 * Overlay sectors are flushed to IndexedDB every 5 seconds (configurable).
 * On load, dirty sectors are restored from IndexedDB.
 *
 * @fileoverview COW storage overlay
 */

// ─── Constants ───────────────────────────────────────────────────────────

const SECTOR_SIZE = 512;
const DB_NAME = "amp-linux-vm-cow";
const DB_VERSION = 1;
const STORE_NAME = "sectors";
const FLUSH_INTERVAL = 5000; // 5 seconds
const MAX_DIRTY_SECTORS = 500; // Before forced flush

// ─── COW Disk Class ──────────────────────────────────────────────────────

export class COWDisk {
  /**
   * @param {ArrayBuffer} baseImage - The read-only base disk image from AMP CDN
   */
  constructor(baseImage) {
    /** @type {ArrayBuffer} Read-only base disk image */
    this.base = baseImage;

    /** @type {Map<number, Uint8Array>} In-memory dirty sector cache */
    this.overlay = new Map();

    /** @type {Set<number>} Sectors that need flushing to IndexedDB */
    this.dirty = new Set();

    /** @type {IDBDatabase|null} IndexedDB database */
    this.db = null;

    /** @type {number|null} Periodic flush timer */
    this._flushTimer = null;

    /** @type {boolean} Whether the database is ready */
    this._ready = false;
  }

  // ─── Initialization ──────────────────────────────────────────────────

  /**
   * Initializes the overlay storage. Must be called before reads/writes.
   * Loads previously persisted dirty sectors from IndexedDB.
   */
  async init() {
    this.db = await openDatabase();

    // Load all persisted sectors into memory
    const persisted = await loadAllSectors(this.db);
    for (const [sectorNum, data] of persisted) {
      this.overlay.set(sectorNum, data);
      // Don't mark as dirty — already persisted
    }

    // Start periodic flush
    this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
    this._ready = true;

    console.log(
      `COW overlay initialized: ${persisted.size} persisted sectors ` +
      `(${(persisted.size * SECTOR_SIZE / (1024 * 1024)).toFixed(1)}MB)`
    );
  }

  // ─── Read ────────────────────────────────────────────────────────────

  /**
   * Reads sectors from the disk.
   *
   * @param {number} sector - Starting sector number
   * @param {number} count - Number of sectors to read
   * @returns {ArrayBuffer} Requested sector data
   */
  read(sector, count = 1) {
    if (!this._ready) throw new Error("COW overlay not initialized");

    const result = new Uint8Array(count * SECTOR_SIZE);

    for (let i = 0; i < count; i++) {
      const sectorNum = sector + i;
      const offset = i * SECTOR_SIZE;

      if (this.overlay.has(sectorNum)) {
        // Read from overlay (COW-modified)
        const data = this.overlay.get(sectorNum);
        result.set(data, offset);
      } else {
        // Read from base image
        const baseOffset = sectorNum * SECTOR_SIZE;
        if (baseOffset + SECTOR_SIZE <= this.base.byteLength) {
          const baseSlice = new Uint8Array(
            this.base.slice(baseOffset, baseOffset + SECTOR_SIZE)
          );
          result.set(baseSlice, offset);
        }
        // If beyond base image, leave as zeros (sparse file behavior)
      }
    }

    return result.buffer;
  }

  /**
   * Reads a range of bytes (not sector-aligned).
   *
   * @param {number} offset - Byte offset in disk
   * @param {number} length - Number of bytes to read
   * @returns {ArrayBuffer}
   */
  readBytes(offset, length) {
    // Determine which sectors to read
    const firstSector = Math.floor(offset / SECTOR_SIZE);
    const lastByte = offset + length - 1;
    const lastSector = Math.floor(lastByte / SECTOR_SIZE);
    const sectorCount = lastSector - firstSector + 1;

    // Read all sectors
    const sectorData = new Uint8Array(this.read(firstSector, sectorCount));

    // Extract the requested byte range
    const startInBuffer = offset - firstSector * SECTOR_SIZE;
    return sectorData.slice(startInBuffer, startInBuffer + length).buffer;
  }

  // ─── Write ───────────────────────────────────────────────────────────

  /**
   * Writes sectors to the overlay.
   *
   * @param {number} sector - Starting sector number
   * @param {ArrayBuffer} data - Data to write (must be multiple of SECTOR_SIZE)
   */
  write(sector, data) {
    if (!this._ready) throw new Error("COW overlay not initialized");

    const arr = new Uint8Array(data);
    const count = Math.ceil(arr.length / SECTOR_SIZE);

    for (let i = 0; i < count; i++) {
      const sectorNum = sector + i;
      const offset = i * SECTOR_SIZE;
      const sectorData = arr.slice(offset, Math.min(offset + SECTOR_SIZE, arr.length));

      // Pad to full sector if needed
      const padded = new Uint8Array(SECTOR_SIZE);
      padded.set(sectorData);

      this.overlay.set(sectorNum, padded);
      this.dirty.add(sectorNum);
    }

    // Auto-flush if we have lots of dirty sectors
    if (this.dirty.size >= MAX_DIRTY_SECTORS) {
      this.flush();
    }
  }

  /**
   * Writes a range of bytes (not sector-aligned).
   * Reads the affected sectors, patches them, and writes back.
   *
   * @param {number} offset - Byte offset in disk
   * @param {ArrayBuffer} data - Data to write
   */
  writeBytes(offset, data) {
    const arr = new Uint8Array(data);

    // Determine which sectors to read/modify/write
    const firstSector = Math.floor(offset / SECTOR_SIZE);
    const lastByte = offset + arr.length - 1;
    const lastSector = Math.floor(lastByte / SECTOR_SIZE);
    const sectorCount = lastSector - firstSector + 1;

    // Read all affected sectors (from overlay or base)
    const sectorData = new Uint8Array(this.read(firstSector, sectorCount));

    // Patch the bytes
    const startInBuffer = offset - firstSector * SECTOR_SIZE;
    sectorData.set(arr, startInBuffer);

    // Write back all sectors
    this.write(firstSector, sectorData.buffer);
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  /**
   * Flushes all dirty sectors to IndexedDB.
   */
  async flush() {
    if (!this.db || this.dirty.size === 0) return;

    const toFlush = [...this.dirty];
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    for (const sectorNum of toFlush) {
      const data = this.overlay.get(sectorNum);
      store.put(data, sectorNum);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    this.dirty.clear();
    console.debug(`Flushed ${toFlush.length} sectors to IndexedDB`);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Returns the overlay size in bytes.
   */
  getOverlaySize() {
    return this.overlay.size * SECTOR_SIZE;
  }

  /**
   * Destroys the overlay, clearing IndexedDB and memory.
   */
  async destroy() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
    }
    await this.flush();
    this.overlay.clear();
    this.dirty.clear();
    this._ready = false;
  }

  /**
   * Resets the overlay (deletes all changes, fresh base image).
   */
  async reset() {
    await this.destroy();
    if (this.db) {
      await clearAllSectors(this.db);
    }
    await this.init();
  }
}

// ─── IndexedDB Helpers ───────────────────────────────────────────────────

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadAllSectors(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();

    const sectors = new Map();

    request.onsuccess = async () => {
      const keys = request.result;
      // Load each sector
      for (const key of keys) {
        const dataRequest = store.get(key);
        await new Promise((r) => {
          dataRequest.onsuccess = () => {
            sectors.set(key, new Uint8Array(dataRequest.result));
            r();
          };
        });
      }
      resolve(sectors);
    };
    request.onerror = () => reject(request.error);
  });
}

async function clearAllSectors(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ─── Export ──────────────────────────────────────────────────────────────

export { SECTOR_SIZE };
export default { COWDisk, SECTOR_SIZE };
