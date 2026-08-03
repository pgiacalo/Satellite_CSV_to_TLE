# Satellite CSV ↔ TLE Converter

A tiny, **100% client-side** web app that converts satellite ephemeris data
**in either direction** between [CelesTrak](https://celestrak.org/) **OMM / CSV**
format and **NORAD two-line element sets (TLE)**. Pick a direction, drag-and-drop a
file, and it downloads the converted result. Nothing is uploaded anywhere — all
conversion happens in your browser.

👉 **Live app:** `https://<your-username>.github.io/<your-repo>/`

## Features

- **Choose a direction first** — a required, obvious first step at the top of the
  card. Defaults to **CSV → TLE**; flip it to **TLE → CSV** to go the other way.
- **Drag & drop** a file, or **click to browse** for one.
- **CSV → TLE:** converts every satellite to a standard 3-line TLE (name + line 1 +
  line 2), with correct fixed-column formatting and mod-10 checksums.
- **TLE → CSV:** parses a 2-line or 3-line TLE file back into a CelesTrak OMM CSV.
  It emits **exactly the precision the TLE encodes** and never invents digits, so
  the round-trip **TLE → CSV → TLE is byte-for-byte identical** (verified in tests).
- Output keeps the **same base name** as the input; only the extension changes to
  match the destination format — `.tle` when converting CSV → TLE, `.csv` when
  converting TLE → CSV (`stations.csv` ↔ `stations.tle`).
- After each conversion you get a clear "saved to Downloads" message, an inline
  **preview**, a **View** button (opens the result in a new tab), and a **Copy** button.
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
own TLE export (verified against 800+ live satellites; see *Testing*). The file
keeps the input's base name and gets a `.tle` extension.

### TLE → CSV (reverse)

**Input** — a NORAD TLE file: pairs of lines starting with `1 ` and `2 `, each
optionally preceded by a satellite-name line. Both 2-line and 3-line files work.

**Output** — a CelesTrak OMM CSV with the standard column header, keeping the
input's base name with a `.csv` extension (`stations.tle` → `stations.csv`).

**On precision** — a TLE holds *less* precision than the original OMM CSV in a few
fields (eccentricity is 7 digits; BSTAR and the second mean-motion derivative are
5 significant figures). The reverse converter emits exactly what the TLE encodes
and adds nothing, so no precision present in the TLE is lost, and
`TLE → CSV → TLE` reproduces the original bytes exactly.

## A note on where the file is saved

The brief asked for the output to land *in the same folder as the input CSV, with
the same name*. Writing back to the input's exact folder is **only** possible with
the browser **File System Access API**, which the brief also asked to avoid (and
which several browsers don't support). For the same security reason, a web page
cannot open your OS file manager or launch a local file. So instead:

- the output keeps the **same base name** (only the extension changes to match the
  destination format), and
- it saves to your **browser's Downloads folder**, with a clear on-screen message,
  an inline preview, and **View** / **Copy** buttons for the generated data.

**Note on the `.tle` extension.** macOS/Windows don't register `.tle`, so
double-clicking the file may pop an "open with…" prompt — open it from your text
editor, or use the **View** button to see the result in a new browser tab.

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
| `converter.js` | Pure CSV↔TLE conversion logic (both directions). Runs in the browser and Node. |
| `test/verify.mjs` | Node test suite. |
| `sample-stations.csv` | A sample CelesTrak CSV to try it with. |
