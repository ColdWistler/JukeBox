# JukeBox

A browser jukebox for the songs in `Music/`. Drop audio files on the page to
add a local playlist, or use the `Music/` folder to publish a library.

## Adding songs to the library

1. Put the audio file in `Music/` (subfolders are fine).
2. `git add` and `git push` it.

That is the whole workflow. A GitHub Actions workflow
(`.github/workflows/update-manifest.yml`) notices the change to `Music/`,
re-runs `gen-manifest.mjs`, commits the updated `manifest.js`, and makes sure
GitHub Pages rebuilds.

**Important:** `script.js` builds the playlist from the hardcoded `MANIFEST`
array in `manifest.js` — it never lists the `Music/` folder itself, because a
static site cannot enumerate a directory. A file sitting in `Music/` but missing
from `manifest.js` is deployed and playable, but invisible in the playlist.

## Running manifest generation locally

If you want the playlist without waiting for CI:

```sh
node gen-manifest.mjs
```

Then open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
```

## Notes

- Accepted formats: `mp3`, `wav`, `ogg`, `oga`, `m4a`, `aac`, `flac`, `opus`, `webm`
- GitHub Pages rejects files over 100 MB and warns past 50 MB, so very large
  audio will not deploy. Lossless files like `.wav` add up quickly; prefer
  `.mp3` or `.ogg` for anything that isn't a short test clip.
- GitHub Pages serves assets with a cache lifetime of up to 10 minutes, so the
  first load after a new song is pushed can briefly show the old playlist.
  A hard refresh clears it.
