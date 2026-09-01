# Desktop resources

`icon.png` (1024×1024, transparent) is generated from the frontend's own Kathara logo
(`services/frontend/src/assets/kathara-logo.png`) by cropping the isometric-boxes mark off the
left of the wordmark and centring it on a square canvas.

Regenerate it with:

```bash
python3 scripts/make-icon.py
```

That script uses only the Python standard library — no Pillow or ImageMagick required. Run it if
the source logo changes. electron-builder derives every platform variant (`.icns`, `.ico`) from
this single file, and it is also shipped as a plain resource so `BrowserWindow`'s `icon` option
has a real path at runtime.
