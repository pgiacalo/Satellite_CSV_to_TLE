# Satellite CSV → TLE Converter

A tiny, **100% client-side** web app that converts satellite ephemeris data from
[CelesTrak](https://celestrak.org/) **OMM / CSV** format into **NORAD two-line
element sets (TLE)**. Drag-and-drop a `.csv` file and it downloads the matching
`.tle` file. Nothing is uploaded anywhere — all conversion happens in your browser.

👉 **Live app:** `https://<your-username>.github.io/<your-repo>/`

## Features

- **Drag & drop** a CSV, or **click to browse** for one.
- Converts every satellite in the file to a standard 3-line TLE (name + line 1 + line 2),
  with correct fixed-column formatting and mod-10 checksums.
- Output file gets the **same base name** with a `.tle` extension
  (`stations.csv` → `stations.tle`).
- No servers, no tracking, no build step, no dependencies. Works offline.
- **No File System Access API** — uses a plain download, so it works in every browser.

## Formats

**Input** — CelesTrak "GP" data exported as **CSV** (a.k.a. OMM in CSV form). The
header row must contain the standard columns:

```
OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION,
RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, EPHEMERIS_TYPE,
CLASSIFICATION_TYPE, NORAD_CAT_ID, ELEMENT_SET_NO, REV_AT_EPOCH,
BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT
```

Grab one from CelesTrak by choosing **CSV** as the format, e.g.
<https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv>

**Output** — a standard NORAD/TLE file, byte-for-byte compatible with CelesTrak's
own TLE export (verified against 800+ live satellites; see *Testing*).

## A note on where the file is saved

The brief asked for the `.tle` to land *in the same folder as the input CSV, with
the same name*. Writing back to the input's exact folder is **only** possible with
the browser **File System Access API**, which the brief also asked to avoid (and
which several browsers don't support). So instead:

- the output keeps the **same base name** with a `.tle` extension, and
- it saves to your **browser's download location** (usually `~/Downloads`, or
  wherever you've pointed downloads).

If you'd rather it truly overwrite alongside the source file, that requires the
File System Access API and a permission prompt — happy to add it as an optional
"advanced" mode. Just say the word.

## Deploying to GitHub Pages

This is a static site — the repo root **is** the site. To publish:

1. Create a GitHub repository and push these files (`index.html`, `converter.js`) to it:
   ```bash
   git init
   git add .
   git commit -m "Satellite CSV to TLE converter"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment**.
3. Set **Source** to *Deploy from a branch*, **Branch** = `main`, folder = `/ (root)`, then **Save**.
4. Wait a minute; your app is live at `https://<you>.github.io/<repo>/`.

No build, no Actions, no Jekyll config needed — GitHub serves `index.html` directly.

## Running locally

Because `index.html` loads `converter.js` as a separate file, open it through a
local web server (opening the `file://` path directly also works in most browsers,
but a server avoids any origin quirks):

```bash
cd <repo>
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## Testing

The conversion logic (`converter.js`) has a self-contained test suite that pins a
byte-exact ISS conversion and exercises every edge-case formatter:

```bash
node test/verify.mjs
```

The converter has also been validated against live CelesTrak data (`stations`,
`geo`, `last-30-days` groups — 800+ satellites), reproducing CelesTrak's published
TLEs exactly for every record whose element set matched.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole UI (drag-drop, browse, download). Self-contained. |
| `converter.js` | Pure CSV→TLE conversion logic. Runs in the browser and Node. |
| `test/verify.mjs` | Node test suite. |
| `sample-stations.csv` | A sample CelesTrak CSV to try it with. |
