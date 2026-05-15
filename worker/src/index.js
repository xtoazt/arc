/**
 * AMP CDN Origin Server — serves content prefixed with font headers.
 *
 * This is the transparent origin behind the AMP CDN. All client traffic
 * goes through Google's AMP CDN edge (not directly to this worker).
 *
 * Flow:
 *  Client → AMP CDN (Google edge) → this origin → content
 *
 * Responsibilities:
 *  1. Receive request from AMP CDN (or direct fallback)
 *  2. Look up the requested chunk/asset
 *  3. Prepends a 298-byte valid TrueType font
 *  4. Returns the combined response with CORS headers
 *  5. Proxies external URLs on behalf of the VM (AMP CDN cached)
 *
 * @fileoverview AMP CDN Origin Worker
 */

import { getFontHeader, FONT_HEADER_SIZE } from './font-header.js';
import { handleProxyRequest } from './proxy.js';
import { CHUNK_MAP, getChunk, getAsset } from './chunks.js';

// ─── Constants ───────────────────────────────────────────────────────────

const CACHE_MAX_AGE = 2592000; // 30 days
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Max-Age": "86400",
};

// ─── Request Router ──────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── Proxy endpoint — tunnels external URLs/APIs through AMP CDN ─
      if (path.startsWith("/proxy/")) {
        return handleProxyRequest(request, url, path, getFontHeader);
      }

      // ── Health check / status endpoint ───────────────────────────────
      if (path === "/status" || path === "/") {
        return statusResponse();
      }

      // ── Chunk serving (disk chunks, WASM, JS, BIOS, kernel, initrd) ──
      const chunkName = path.replace(/^\//, "").replace(/\//g, "-");
      if (CHUNK_MAP[chunkName] || chunkName.match(/^disk-\d+$/) || chunkName.match(/^(v86|bzimage|initrd|seabios|vgabios)/)) {
        return serveChunk(request, chunkName, env, ctx);
      }

      // ── Fallback: 404 ────────────────────────────────────────────────
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });

    } catch (err) {
      console.error(`Origin error on ${path}:`, err);
      return new Response(`Internal Error: ${err.message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};

// ─── Chunk Serving ───────────────────────────────────────────────────────

async function serveChunk(request, name, env, ctx) {
  const url = new URL(request.url);

  // Check Cloudflare edge cache
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let response = await cache.match(cacheKey);
  if (response) {
    return response;
  }

  // Get the chunk data
  let data;

  // Try R2 bucket first (preferred — cheaper storage)
  if (env.VM_ASSETS) {
    const object = await env.VM_ASSETS.get(name);
    if (object) {
      data = new Uint8Array(await object.arrayBuffer());
    }
  }

  // Try KV namespace (fallback)
  if (!data && env.VM_CHUNKS) {
    const stored = await env.VM_CHUNKS.get(name, "arrayBuffer");
    if (stored) {
      data = new Uint8Array(stored);
    }
  }

  // Try inline/static chunks
  if (!data) {
    data = getChunk(name);
  }

  if (!data) {
    return new Response(`Chunk not found: ${name}`, {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  // Prepend font header
  const font = getFontHeader();
  const combined = new Uint8Array(font.length + data.length);
  combined.set(font);
  combined.set(data, font.length);

  // Build response
  response = new Response(combined, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}, immutable`,
      "X-Chunk-Name": name,
      "X-Chunk-Size": String(data.length),
      "X-Font-Header-Size": String(FONT_HEADER_SIZE),
      ...CORS_HEADERS,
    },
  });

  // Cache in Cloudflare edge
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ─── Status Endpoint ─────────────────────────────────────────────────────

function statusResponse() {
  const chunks = Object.keys(CHUNK_MAP);

  return new Response(
    JSON.stringify(
      {
        service: "AMP Linux VM — Origin Server",
        status: "healthy",
        role: "AMP CDN origin (transparent to clients)",
        fontHeaderSize: FONT_HEADER_SIZE,
        chunks: chunks,
        endpoints: {
          proxy: "/proxy/<encoded-url> (via AMP CDN)",
          chunk: "/<chunk-name>",
          status: "/status",
        },
        ampCdnPattern:
          "https://<publisher>--<worker>-<org>-workers-dev.cdn.ampproject.org/r/s/<worker>.<org>.workers.dev/<path>",
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    }
  );
}
