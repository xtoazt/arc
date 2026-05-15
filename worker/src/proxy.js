/**
 * URL/API Proxy module for the AMP CDN origin.
 *
 * Proxies external URLs and APIs through the origin, enabling:
 *  1. CORS bypass for external resources
 *  2. Request modification (add headers, rewrite URLs)
 *  3. Response caching at the AMP CDN edge
 *  4. Rate limiting and abuse prevention
 *  5. WebSocket tunneling for real-time traffic
 *
 * Client → AMP CDN → this origin → external URL
 * AMP CDN caches font-prepended responses on Google's edge.
 *
 * @fileoverview URL/API proxy (AMP CDN origin side)
 */

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_PROXY_SIZE = 50 * 1024 * 1024; // 50MB max response
const PROXY_TIMEOUT = 30000; // 30 seconds
const RATE_LIMIT_WINDOW = 60; // 1 minute
const RATE_LIMIT_MAX = 200; // requests per minute (increased for AMP CDN usage)

// Simple in-memory rate limiter (per-IP, per-minute)
const rateLimitMap = new Map();

// ─── CORS Headers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// ─── Main Proxy Handler ──────────────────────────────────────────────────

/**
 * Handles a proxy request.
 * Path format: /proxy/<base64url-encoded-target-url>
 * Query params: method, headers (JSON-encoded)
 */
export async function handleProxyRequest(request, url, path, getFontHeaderFn) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Rate limiting
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(clientIP)) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: { "Retry-After": "60", ...CORS_HEADERS },
    });
  }

  // Extract target URL from path
  const encodedUrl = path.replace("/proxy/", "");
  if (!encodedUrl) {
    return new Response("Missing target URL. Use /proxy/<base64url-encoded-url>", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  let targetUrl;
  try {
    // Decode base64url → base64 → string
    const base64 = encodedUrl.replace(/-/g, "+").replace(/_/g, "/");
    targetUrl = atob(base64);
  } catch {
    // Try direct (for simple cases)
    try {
      targetUrl = decodeURIComponent(encodedUrl);
    } catch {
      return new Response("Invalid URL encoding", {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
  }

  // Validate URL
  try {
    new URL(targetUrl);
  } catch {
    return new Response(`Invalid target URL: ${targetUrl}`, {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  // Parse proxied request options from headers
  const proxyMethod = request.headers.get("X-Proxy-Method") || "GET";
  let proxyHeaders = {};
  try {
    const headersJson = request.headers.get("X-Proxy-Headers");
    if (headersJson) {
      proxyHeaders = JSON.parse(headersJson);
    }
  } catch {
    // Ignore bad headers JSON
  }
  const proxyBody = request.body;

  // Build the proxied request
  const proxyRequest = new Request(targetUrl, {
    method: proxyMethod,
    headers: {
      "User-Agent": "AMP-Linux-VM/1.0 Proxy",
      Accept: "*/*",
      ...proxyHeaders,
    },
    body: proxyMethod !== "GET" && proxyMethod !== "HEAD" ? proxyBody : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(PROXY_TIMEOUT),
  });

  try {
    // Fetch the target
    const response = await fetch(proxyRequest);

    // Read the full response body
    const responseBody = await response.arrayBuffer();

    // Prepend font header so AMP CDN caches this proxy response
    // This is critical: without the font header, AMP CDN won't cache
    const font = typeof getFontHeaderFn === 'function' ? getFontHeaderFn() : new Uint8Array(0);
    const combined = new Uint8Array(font.length + responseBody.byteLength);
    combined.set(font);
    combined.set(new Uint8Array(responseBody), font.length);

    // Build response headers
    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=2592000, s-maxage=2592000, immutable");
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-Proxy-Target", targetUrl);
    headers.set("X-Proxy-Status", String(response.status));
    headers.set("X-Font-Header-Size", String(font.length));

    return new Response(combined, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error(`Proxy error for ${targetUrl}:`, err.message || err);
    return new Response(JSON.stringify({ error: err.message || "Unknown proxy error" }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────

function isRateLimited(ip) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;

  // Clean up old entries
  for (const [key, timestamp] of rateLimitMap) {
    if (timestamp < windowStart) {
      rateLimitMap.delete(key);
    }
  }

  const key = `${ip}:${windowStart}`;
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);

  return count > RATE_LIMIT_MAX;
}

// ─── WebSocket Proxy (for real-time traffic) ─────────────────────────────

/**
 * Creates a WebSocket pair that tunnels traffic through the proxy.
 * The VM guest's NE2000 network stack uses this for outbound connections.
 */
export function createWebSocketProxy(targetUrl) {
  // Return the target URL — the main thread handles WebSocket directly
  // because Cloudflare Workers support WebSocket natively
  return targetUrl;
}

export default {
  handleProxyRequest,
  createWebSocketProxy,
};
