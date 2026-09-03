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

`splash.png` (1200×269, transparent) is the Kathara wordmark shown by src/splash.html on a plain
white page, centred, for exactly as long as the app takes to boot — no fixed duration, since it's
a static image rather than an animation. Downscaled (box-filtered, premultiplied alpha) from
`/home/tommaso/workspace/Kathara_Logo_Vettoriale.png` (5283×1183): the source is much higher
resolution than a splash logo ever needs to be shown at, so shipping it as-is would just add
~120KB of dead weight. main.ts goes fullscreen once startup() actually succeeds, or windows.ts's
showSetupPage takes over (back in a normal window) if something needs the user's attention.
Copied into `build/` by scripts/build.mjs, next to setup.html, so it ships the same way in both a
dev checkout and a packaged app.
