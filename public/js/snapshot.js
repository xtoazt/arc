/**
 * VM Snapshot Manager — Save/restore v86 VM state via IndexedDB.
 *
 * Snapshots enable **instant boot** (1-3 seconds vs 15-30 seconds):
 *  - After first boot, the VM state is serialized and stored in IndexedDB.
 *  - Subsequent sessions restore from the snapshot — no kernel boot, no init.
 *  - The snapshot captures RAM, CPU state, and device states.
 *
 * Storage budget: typically 50-100MB for a 256MB RAM VM.
 * IndexedDB handles large values efficiently via structured clone.
 *
 * @fileoverview VM snapshot persistence
 */

// ─── Constants ───────────────────────────────────────────────────────────

const DB_NAME = "amp-linux-vm-snapshots";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "booted-state";

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Saves a VM snapshot to IndexedDB.
 *
 * @param {ArrayBuffer|Uint8Array} snapshotData - Serialized VM state from v86
 * @returns {Promise<void>}
 */
export async function saveSnapshot(snapshotData) {
  const db = await openDatabase();
  const data = snapshotData instanceof Uint8Array
    ? snapshotData
    : new Uint8Array(snapshotData);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(data, SNAPSHOT_KEY);

    tx.oncomplete = () => {
      db.close();
      console.log(
        `Snapshot saved: ${(data.byteLength / 1024 / 1024).toFixed(1)}MB`
      );
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Loads a VM snapshot from IndexedDB.
 *
 * @returns {Promise<Uint8Array|null>} Snapshot data, or null if not found
 */
export async function loadSnapshot() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(SNAPSHOT_KEY);

    request.onsuccess = () => {
      db.close();
      const result = request.result;
      if (result) {
        console.log(
          `Snapshot loaded: ${(result.byteLength / 1024 / 1024).toFixed(1)}MB`
        );
        resolve(result instanceof Uint8Array ? result : new Uint8Array(result));
      } else {
        resolve(null);
      }
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Checks whether a saved snapshot exists.
 *
 * @returns {Promise<boolean>}
 */
export async function hasSnapshot() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.count(SNAPSHOT_KEY);

    request.onsuccess = () => {
      db.close();
      resolve(request.result > 0);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Deletes the saved snapshot (e.g., after major disk changes).
 *
 * @returns {Promise<void>}
 */
export async function deleteSnapshot() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(SNAPSHOT_KEY);

    tx.oncomplete = () => {
      db.close();
      console.log("Snapshot deleted");
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Gets the total storage used by snapshots.
 *
 * @returns {Promise<number>} Size in bytes
 */
export async function getSnapshotSize() {
  const snapshot = await loadSnapshot();
  return snapshot ? snapshot.byteLength : 0;
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
    request.onblocked = () => {
      console.warn("Snapshot DB blocked — closing stale connections");
      request.result?.close();
    };
  });
}

export default {
  saveSnapshot,
  loadSnapshot,
  hasSnapshot,
  deleteSnapshot,
  getSnapshotSize,
};
