# BG Remover

Remove image backgrounds and resize images in the browser. Everything runs client-side: images are never uploaded anywhere.

- Background removal with [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) (IS-Net segmentation on onnxruntime-web, WebGPU when available, multi-threaded WASM otherwise)
- Three model sizes: Fast / Balanced / Best. Model files are fetched from IMG.LY's CDN on first use and then cached by the browser
- Refine with a brush: erase / restore with adjustable size and hardness, zoom and pan, undo/redo, and a faint overlay of the original to show what was removed
- Crop to subject with padding
- Resize by percent or exact pixels (aspect lock), with stepped downscaling for clean edges
- Transparent or solid-color background, export as PNG / WebP / JPEG with quality control
- Drop, pick, or paste (Ctrl+V) an image

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
```

## Deploy

It's a static site. `public/_headers` sets `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, which enables multi-threaded inference; keep those headers on whatever host you use.

Cloudflare (Workers static assets):

```bash
npx wrangler login
npm run cf:deploy
```

## License note

`@imgly/background-removal` is AGPL-3.0. Hosting this publicly is fine for personal use, but the AGPL requires offering the app's source to its users; commercial closed-source use needs a license from IMG.LY.
