# AMP Linux VM

**Full Linux virtual machine served via Google AMP CDN's font trick — open the SVG, get a terminal.**

## Quick Start

### Option 1: Open the SVG directly (jsDelivr/CDN)

```
https://cdn.jsdelivr.net/gh/xtoazt/arc@main/public/amp-linux-vm.svg
```

Just open that URL in any browser. A Linux terminal boots in ~15-30 seconds (cold) or ~1-3 seconds (warm, after first visit).

### Option 2: Open locally

```bash
git clone https://github.com/xtoazt/arc.git
cd arc
open public/amp-linux-vm.svg
```

### Option 3: Dev server (with hot reload)

```bash
npm install
npx serve public -p 8080
# Open http://localhost:8080
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (amp-linux-vm.svg)                      │
│  ┌───────────────────────────────────────────┐  │
│  │  foreignObject (HTML UI)                   │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  v86 x86 Emulator (WASM)            │  │  │
│  │  │  • Runs on main thread               │  │  │
│  │  │  • requestAnimationFrame rendering   │  │  │
│  │  │  • COW disk overlay (IndexedDB)      │  │  │
│  │  │  • Snapshot save/restore             │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
│                       │                          │
│            AMP CDN (Google Edge)                 │
│                       │                          │
│            Cloudflare Worker (origin)            │
│            • Font header prepending              │
│            • Chunk serving                       │
│            • URL/API proxy                       │
└─────────────────────────────────────────────────┘
```

## How It Works

1. **AMP CDN Font Trick**: Cloudflare Worker prepends 298 bytes of a valid TrueType font to every response. Google's AMP CDN sees "valid font" and caches it on their edge network (200+ PoPs globally).

2. **SVG Self-Containment**: The SVG file contains all HTML/CSS/JS inline via `<foreignObject>`. No external dependencies at load time — everything fetches from AMP CDN at runtime.

3. **v86 Emulation**: Full x86 emulation in WebAssembly, running Linux with:
   - Copy-on-write disk overlay (IndexedDB)
   - VM snapshot save/restore (instant warm boots)
   - Framebuffer rendering at 30fps
   - Keyboard + mouse input forwarding

4. **URL Proxy**: External URLs from the VM are proxied through AMP CDN → origin worker → target, enabling CORS-free access.

## File Structure

```
arc/
├── public/
│   ├── amp-linux-vm.svg      ★ Self-contained SVG terminal
│   ├── index.html             HTML version (for dev server)
│   ├── css/main.css           Terminal UI styling
│   └── js/
│       ├── amp-vm-bundle.js   Bundled JS (no ES modules)
│       ├── amp-loader.js      AMP CDN loader + proxy
│       ├── vm-boot.js         VM boot orchestrator
│       ├── vm-worker.js       Web Worker for v86
│       ├── disk-assembler.js  Disk chunk assembly
│       ├── cow-storage.js     COW overlay storage
│       ├── snapshot.js        VM snapshot persistence
│       └── font-header.js     Font header utilities
├── worker/
│   └── src/
│       ├── index.js           Cloudflare Worker entry
│       ├── proxy.js           URL/API proxy handler
│       ├── chunks.js          Chunk map & serving
│       └── font-header.js     Font header for AMP CDN
├── package.json
├── wrangler.toml
└── README.md
```

## Deployment

### Cloudflare Worker

```bash
# 1. Install dependencies
npm install

# 2. Login to Cloudflare
npx wrangler login

# 3. Create KV namespace for VM chunks
npx wrangler kv:namespace create VM_CHUNKS
npx wrangler kv:namespace create VM_CHUNKS --preview

# 4. Create R2 bucket for VM assets
npx wrangler r2 bucket create amp-linux-vm-assets

# 5. Update wrangler.toml with the KV namespace IDs and R2 bucket name
#    (the output from steps 3-4 will show the IDs)

# 6. Upload your disk chunks to KV or R2
#    (use wrangler kv:bulk put or r2 object put)

# 7. Deploy
npx wrangler deploy

# 8. Get your worker URL
npx wrangler whoami
# Worker will be at: <worker-name>.<your-subdomain>.workers.dev
```

After deployment, update `AMP_BASE` and `ORIGIN_BASE` in the SVG/js files and re-push to GitHub.

After deployment, update `AMP_BASE` and `ORIGIN_BASE` in:
- `public/amp-linux-vm.svg` (line ~230, inside `<script>` tag)
- `public/js/amp-vm-bundle.js` (top of file)
- `public/js/amp-loader.js` (top of file)

**AMP_BASE** format: `https://<publisher>--<worker-name>-<org>-workers-dev.cdn.ampproject.org/r/s/<worker-name>.<org>.workers.dev`

**ORIGIN_BASE** format: `https://<worker-name>.<org>.workers.dev`

### GitHub Pages / jsDelivr

Push to GitHub, then access via:

```
https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/public/amp-linux-vm.svg
```

jsDelivr caches GitHub files on their CDN (fast, free).

## Requirements

- Modern browser with WebAssembly support (Chrome, Firefox, Safari, Edge)
- ~256MB RAM recommended
- IndexedDB available (for snapshots and COW overlay)

## License

MIT
