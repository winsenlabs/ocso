# OCSO brand

The mark is **Route**: one line comes in, the router splits it, and the chosen queue is lit. That is
OCSO's path, channel → router → queue → agent.

| File | Use |
|---|---|
| `ocso-mark.svg` | The mark on light backgrounds (dark tile). Favicon source (`apps/web/app/icon.svg`). |
| `ocso-mark-inverse.svg` | The mark on dark backgrounds (white tile). |
| `ocso-glyph.svg` | The glyph without a tile, for tight spaces; the app draws it in white for the Ask OCSO portrait. |
| `ocso-logo.svg` / `ocso-logo-inverse.svg` | Mark plus wordmark, for light / dark backgrounds (README header). |
| `ocso-mark-512.png` | Raster mark for places that do not take SVG. |
| `ocso-social-preview.png` | GitHub social preview (1280×640): repository Settings → Social preview. |

Colours: ink `#11171D`, accent `#3D5DCF` (the app's `--accent`, `oklch(52% 0.18 268)`), white.
The wordmark is Geist Bold outlined to paths (Geist: SIL Open Font License 1.1, © Vercel), tracked −3%.
Keep the tile's corner radius (18 of 64), keep clear space of a quarter of the mark on every side, and
do not recolour the lit dot to anything but the accent (or white on an accent background).

Web app assets rendered from these sources: `apps/web/app/{icon.svg,favicon.ico,apple-icon.png,opengraph-image.png}`
and `apps/web/public/icons/*` (the web manifest, `apps/web/app/manifest.ts`).
