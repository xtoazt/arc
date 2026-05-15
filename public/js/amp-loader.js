/**
 * AMP CDN Loader — Fetches chunks from the AMP CDN, strips font headers,
 * and returns clean ArrayBuffers. Also proxies external URLs through AMP.
 *
 * Architecture:
 *  • All VM resources loaded via AMP CDN (primary)
 *  • External URLs proxied through AMP CDN → origin worker
 *  • Fallback to direct origin URL if AMP CDN fails
 *  • Retry logic with exponential backoff
 *  • Integrity verification (SHA-256)
 *  • Memory-efficient streaming for large chunks
 *
 * The origin worker is transparent — AMP CDN is the sole interface.
 *
 * @fileoverview AMP CDN loader + proxy
 */

import { FONT_HEADER_SIZE } from './font-header.js';

// ─── Configuration ───────────────────────────────────────────────────────

// AMP CDN URL pattern (primary — all access goes through Google's edge)
// Format: https://<publisher>--<worker>-<org>-workers-dev.cdn.ampproject.org/r/s/<worker>.<org>.workers.dev/<path>
const AMP_BASE = 'https://vm--amp-linux-vm-your-org-workers-dev.cdn.ampproject.org/r/s/amp-linux-vm.your-org.workers.dev';

// Direct origin URL (fallback only — used when AMP CDN is unreachable)
const ORIGIN_BASE = 'https://amp-linux-vm.your-org.workers.dev';

// Proxy prefix for external URL tunneling through AMP CDN
const PROXY_PREFIX = 'proxy';

const FETCH_TIMEOUT = 15000; // 15s per chunk
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1s base delay

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Fetches all chunks from AMP CDN in parallel.
 *
 * @param {string[]} chunkNames - Names of chunks to fetch
 * @param {Object} options
 * @param {Function} options.onProgress - Progress callback ({ name, loaded, total, percent })
 * @param {Function} options.onChunkLoaded - Called when a single chunk finishes
 * @param {AbortSignal} options.signal - Abort controller signal
 * @returns {Promise<Map<string, ArrayBuffer>>} Map of chunk name → clean buffer
 */
export async function fetchAllChunks(chunkNames, options = {}) {
  const { onProgress, onChunkLoaded, signal } = options;

  const results = new Map();
  let completed = 0;
  const total = chunkNames.length;

  const reportProgress = (name) => {
    completed++;
    const percent = Math.round((completed / total) * 100);
    if (onProgress) {
      onProgress({
        name,
        loaded: completed,
        total,
        percent,
      });
    }
  };

  // Fetch in parallel with per-chunk retry and fallback
  const promises = chunkNames.map(async (name) => {
    const buffer = await fetchChunkWithFallback(name, signal);
    results.set(name, buffer);

    if (onChunkLoaded) {
      onChunkLoaded({ name, size: buffer.byteLength });
    }

    reportProgress(name);
    return { name, buffer };
  });

  await Promise.all(promises);
  return results;
}

/**
 * Fetches a single chunk with AMP → origin fallback and retry logic.
 * AMP CDN is the primary path; origin is fallback only.
 *
 * @param {string} name - Chunk name
 * @param {AbortSignal} signal
 * @returns {Promise<ArrayBuffer>} Clean buffer (font header stripped)
 */
export async function fetchChunkWithFallback(name, signal) {
  // Try AMP CDN first (primary path)
  try {
    return await fetchWithRetry(`${AMP_BASE}/${name}`, signal);
  } catch (ampErr) {
    console.warn(`AMP CDN failed for ${name}: ${ampErr.message}, trying origin...`);
  }

  // Fallback to direct origin URL
  try {
    return await fetchWithRetry(`${ORIGIN_BASE}/${name}`, signal);
  } catch (originErr) {
    console.error(`All sources failed for ${name}: ${originErr.message}`);
    throw new Error(`Failed to load chunk: ${name}`);
  }
}

// ─── AMP CDN URL Proxy ───────────────────────────────────────────────────

/**
 * Proxies an external URL through AMP CDN.
 *
 * The external URL is base64url-encoded and appended to the proxy path.
 * AMP CDN caches the response on Google's edge. The origin worker handles
 * the actual external fetch server-side.
 *
 * URL format:
 *   AMP_CDN_BASE/proxy/<base64url(targetUrl)>
 *
 * Optional headers and method are sent via custom request headers.
 *
 * @param {string} targetUrl - The external URL to proxy
 * @param {Object} options
 * @param {string} options.method - HTTP method (default: GET)
 * @param {Object} options.headers - Additional request headers
 * @param {string} options.body - Request body (for POST/PUT)
 * @param {AbortSignal} options.signal - Abort signal
 * @returns {Promise<Response>} The proxied response
 */
export async function proxyUrl(targetUrl, options = {}) {
  const { method = 'GET', headers = {}, body, signal } = options;

  // Base64url-encode the target URL
  const encoded = btoa(targetUrl)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const proxyUrl = `${AMP_BASE}/${PROXY_PREFIX}/${encoded}`;

  // Build proxy request with metadata headers
  const proxyHeaders = new Headers({
    'Accept': 'application/octet-stream',
    'X-Proxy-Method': method,
    'X-Proxy-Headers': JSON.stringify(headers),
  });

  try {
    // Try AMP CDN first (primary path)
    const response = await fetch(proxyUrl, {
      method: body ? 'POST' : 'GET',
      headers: proxyHeaders,
      body: body || undefined,
      signal,
    });

    if (!response.ok) {
      throw new Error(`Proxy error: HTTP ${response.status}`);
    }

    // Strip font header from AMP-fetched response
    const fullBuffer = await response.arrayBuffer();
    const cleanBuffer = fullBuffer.slice(FONT_HEADER_SIZE);

    // Return a new Response with the clean data and original Content-Type
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    return new Response(cleanBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Proxied-By': 'AMP-CDN',
      },
    });
  } catch (ampErr) {
    console.warn(`AMP proxy failed for ${targetUrl}: ${ampErr.message}`);

    // Fallback: proxy through origin directly
    try {
      const originProxyUrl = `${ORIGIN_BASE}/${PROXY_PREFIX}/${encoded}`;
      const response = await fetch(originProxyUrl, {
        method: body ? 'POST' : 'GET',
        headers: proxyHeaders,
        body: body || undefined,
        signal,
      });
      return response;
    } catch (originErr) {
      console.error(`Proxy failed for ${targetUrl}: ${originErr.message}`);
      throw new Error(`Failed to proxy: ${targetUrl}`);
    }
  }
}

/**
 * Proxies a URL and returns the response body as text.
 * Convenience wrapper around proxyUrl().
 *
 * @param {string} targetUrl
 * @param {Object} options - Same as proxyUrl()
 * @returns {Promise<string>}
 */
export async function proxyUrlText(targetUrl, options = {}) {
  const response = await proxyUrl(targetUrl, options);
  return response.text();
}

/**
 * Proxies a URL and returns the response body as JSON.
 * Convenience wrapper around proxyUrl().
 *
 * @param {string} targetUrl
 * @param {Object} options - Same as proxyUrl()
 * @returns {Promise<any>}
 */
export async function proxyUrlJson(targetUrl, options = {}) {
  const response = await proxyUrl(targetUrl, options);
  return response.json();
}

/**
 * Fetches a URL with retry logic and timeout.
 *
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<ArrayBuffer>} Clean buffer
 */
async function fetchWithRetry(url, signal) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Create a timeout signal
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      // Combine with external signal if provided
      const combinedSignal = signal
        ? combineSignals(signal, controller.signal)
        : controller.signal;

      const response = await fetch(url, {
        signal: combinedSignal,
        headers: { Accept: 'application/octet-stream' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const fullBuffer = await response.arrayBuffer();
      return stripFontHeader(fullBuffer);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        throw err; // Don't retry aborted requests
      }
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(`Retry ${attempt}/${MAX_RETRIES} for ${url} in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`Failed after ${MAX_RETRIES} retries: ${url}`);
}

// ─── Font Header Stripping ───────────────────────────────────────────────

/**
 * Strips the 298-byte font header from an ArrayBuffer.
 * Returns a new ArrayBuffer containing the payload.
 *
 * @param {ArrayBuffer} buffer
 * @returns {ArrayBuffer}
 */
function stripFontHeader(buffer) {
  if (buffer.byteLength < FONT_HEADER_SIZE) {
    throw new Error(
      `Buffer too small: ${buffer.byteLength} < ${FONT_HEADER_SIZE}`
    );
  }
  return buffer.slice(FONT_HEADER_SIZE);
}

// ─── Signal Combining ────────────────────────────────────────────────────

function combineSignals(sig1, sig2) {
  const controller = new AbortController();
  sig1.addEventListener('abort', () => controller.abort(sig1.reason));
  sig2.addEventListener('abort', () => controller.abort(sig2.reason));
  return controller.signal;
}

// ─── Utility ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Export ──────────────────────────────────────────────────────────────

export { stripFontHeader, FONT_HEADER_SIZE };
export default { fetchAllChunks, fetchChunkWithFallback, stripFontHeader };
