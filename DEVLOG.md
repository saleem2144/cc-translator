# CC Translator — Development Log

A running record of what has been built, what was decided and why, and what was
tried and rejected. **Future agents: read this first, and add an entry for every
change you make** (newest entries at the bottom of "Change history").

---

## What the project is

A Chrome extension that produces **true closed captions** for Spanish video: it
listens to the video's actual audio, transcribes the Spanish with Whisper, and
translates it to English, showing both lines over the player. It deliberately
does **not** use the site's own subtitles, because Spanish subtitles on
streaming sites often differ from what is actually spoken.

Target sites: YouTube, Netflix, Disney+, Prime Video, Crunchyroll.
The owner intends to publish it eventually (Chrome Web Store).

## Architecture

```
extension/ (Chrome MV3)                         helper/ (local Python server)
 popup ──► background.js (service worker)
             │  starts/stops, relays messages    server.py  ws://127.0.0.1:8765
             ▼                                     │ only accepts chrome-extension:// origins
 offscreen.js: tab audio capture ── 16 kHz PCM ──► │ Silero VAD → sentence detection
   (capture-worklet.js)            ◄── JSON ────── │ faster-whisper large-v3 (CUDA, float16)
             ▼                                     │ translator.py: Opus-MT es→en (CTranslate2)
 content.js (in the video page): overlay, hides site subtitles, synced-mode control
```

- **Helper messages** (seconds since stream start): `partial` (in-progress guess,
  ~every 0.27 s), `speech_end`, `caption` (final line), `no_speech`. Each has a
  sentence `id`.
- **Owner's PC:** Windows 11, RTX 5070 Ti (16 GB). System Python is 3.14 (too new
  for the ML libraries), so the helper uses a **uv-managed Python 3.12** venv in
  `helper/.venv`. uv is installed via winget and may not be on PATH in old shells.
- Models: Whisper large-v3 from the Hugging Face cache; Opus-MT converted once by
  `helper/setup_models.py` into `helper/models/` (git-ignored).

## How to run

1. Helper: `helper/start-helper.bat` (or `helper/.venv/Scripts/python.exe server.py`).
2. Extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
3. After **any** extension code change the owner must click **reload** on the
   extension card (and refresh the video page). Forgetting this once caused a
   long false-negative debugging session.

### Test tools
- `helper/test_client.py file.wav [--speed 1]` — pretends to be the extension and
  prints partial/final captions with lag. Test clips: `helper/test-es.wav`,
  `helper/test-es-fast.wav` (Windows has no Spanish TTS voice; these use an
  English voice reading Spanish, so accuracy on them is not representative).
- `tools/display-test.html` — runs the real `content.js` with stubbed extension
  APIs and replays caption messages (`?flicker=1`, `?frozen=1` variants).
- `tools/sync-test.html` — simulates synced mode with a fake drifting copy.
- Serve these with `python -m http.server 8790` from the repo root.
- `phase0-test/`, `scout-test/` — throwaway feasibility-test extensions.

## Key decisions (and why)

- **Captions come from audio, never from site subtitles** (owner's requirement).
  Reading site subtitle files (how Language Reactor works) is at most a fallback.
- **Live mode** is the default: in-progress words appear while spoken, then a
  final line ~1 s after each sentence ends.
- **"Wait for each line" mode** (pause after each sentence) is built but **hidden**
  behind `WAIT_MODE_ENABLED = false` in `extension/settings.js`, at the owner's
  request. Don't re-expose or polish it unless asked.
- **Synced mode (Crunchyroll only, optional):** a muted copy of the episode plays
  ~8 s ahead in a small window; its audio is captioned and each line is shown on
  the episode at the exact video time it's spoken.
- **Never download or decrypt DRM streams** (Crunchyroll, Netflix, etc.). It's
  illegal anti-circumvention and against the sites' terms. The scout copy is the
  legitimate alternative: it only listens to normal playback.
- **Browser:** stay on Chrome. Edge/Opera are the same engine (no benefit; Opera
  GX limiters may hurt); Firefox/Safari lack tab-audio capture for extensions.

## Rejected approaches (don't retry without asking)

- **Splitting long fast speech at short breaths** (100 ms VAD gaps, a 10 s hard
  cap, no padding at breath cuts, plus a spelled-out-letters filter). The owner
  tested it and said it was worse; it was rolled back on 2026-10-16. The broader
  "Suscríbete / activa notificaciones" hallucination filter was removed with it
  and could be re-added on its own.
- **Word-by-word literal translation** — produces broken English (word order,
  idioms). Instead the English is re-translated as the Spanish grows.
- **Background tab / covered window for the scout copy** — Crunchyroll never
  builds its player on a hidden page.

## Known facts from feasibility tests

- **Phase 0 (2026-10-16):** on all five sites, tab audio capture, tab video
  capture, player pause/play and rewind all worked on the owner's PC.
- **Scout test (2026-10-17, Crunchyroll):** two streams at once worked on the
  owner's plan; the copy must open **visible** (small window in front) for the
  player to load; Chrome requires **one user click on the extension icon in that
  window** before `tabCapture` is allowed (activeTab); once captured, the copy
  keeps playing behind the main window; it drifted about −1.3 s per 10 s.

## Current state (2026-10-17)

- `main` (commit 74fdd90) = known-good live-mode version, on GitHub
  (private repo `saleem2144/cc-translator`).
- Branch `feature/scout-tab-test` = synced mode + scout test + this log.
- Synced mode works but the owner reported it as glitchy: slow to start, and
  some sentences went missing. A likely cause (new lines deleting neighbouring
  lines) was fixed on 2026-10-17 but **not yet retested on Crunchyroll**.
- Open ideas the owner was offered: a 30 s lead in synced mode (more context,
  fewer gaps, slower start); captioning DRM-free local video files into `.srt`.

---

## Change history

### 2026-10-16 — Planning and phase 0
- Discussed design: Chrome extension + local helper using the owner's GPU.
- Built `phase0-test/` (tab audio/video capture + player control test). All five
  sites passed.

### 2026-10-16 — Phase 1: live captions
- Installed uv + Python 3.12; faster-whisper large-v3 runs at ~0.2 s per 5 s
  sentence on the RTX 5070 Ti. Opus-MT es→en via CTranslate2, ~15 ms per line.
- Built `helper/server.py`, `translator.py`, and the extension (capture,
  overlay, site-subtitle hiding for all five sites, popup settings).
- Fix: content script injected on demand (tabs opened before install had none).
- Fix: Opus-MT dropped a sentence when given two at once → translate sentence
  by sentence.
- Fix: Whisper invents "¡Gracias!" on short noises → filtered for clips < 1.2 s.
- Added partial (in-progress) captions; faster sentence detection (0.45 s
  silence, checks every 0.15 s, partials every ~0.27 s).
- Word-by-word reveal; in-progress text is italic; a word only shows once two
  consecutive guesses agree (cut on-screen changes from 9 to 4 in a test).
- Replay-after-rewind only when the video is clearly behind the newest caption
  (a frozen video clock had been able to block in-progress captions).
- Popup diagnostics line added.
- "Wait for each line" hidden behind `WAIT_MODE_ENABLED`.
- Owner changed `MAX_SEGMENT` in `server.py` from 8 s to 4 s (kept).
- Breath-splitting experiment for fast speech → rolled back (see Rejected).
- Initialised git, first commit 74fdd90 on `main`, pushed to private GitHub repo.

### 2026-10-17 — Synced captions for Crunchyroll (branch feature/scout-tab-test)
- Built `scout-test/`; iterated until it passed (visible window + one click).
- Built synced mode into the extension:
  - `background.js`: `startSynced` (pause episode, open muted copy window, wait
    for its player, ask for the click), `onGrant` (start capture with
    `playback: false`, get 8 s ahead, resume episode), `relaySynced` (converts
    caption wall-clock times to the copy's video time via the copy's page).
  - `content.js`: `video-cmd` / `to-video-time` handlers (both pages),
    `onSyncedCaption`, synced display, `syncStep` drift correction.
  - `popup`: "Synced captions" checkbox (Crunchyroll tabs only); opening the
    popup on the copy's window performs the required click (`connectCopy`).
  - `offscreen.js`: `playback` flag so the copy stays silent.
- Drift correction learns the drift (`syncBias`) instead of fixed speed steps;
  in the simulated test the lead held at 7.3–8.4 s.
- Fix: a new synced line deleted any saved line within 0.3 s (back-to-back
  dialogue lost lines). Now lines are replaced only if they overlap by more than
  half of the shorter one. The newer line wins when two overlap on screen.
- Diagnostics show lines received/replaced, copy jumps, and current lead.
- Added this DEVLOG.md and CLAUDE.md.
