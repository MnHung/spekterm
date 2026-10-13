# spekterm reel

A motion-graphics product video for spekterm (60 s, 1920×1080, 30 fps), rendered frame by frame from a web page.

- `index.html` — the whole animation. `render(t)` draws the frame at time `t` (seconds); nothing animates on its own, so every frame is reproducible. Scene timings live in the `T` object near the bottom.
- `render.mjs` — drives Chromium with Playwright, screenshots each frame, and pipes the frames to ffmpeg.
- `audio.py` — synthesizes the soundtrack (numpy only) with hits timed to the scene changes in `index.html`; keep the two in step when you retime a scene.

The screenshots are read from `site/src/assets/screenshots/en/`. The Timeline scene is not a screenshot: it is redrawn from the fixture repository's changes.

## Requirements

Node with `playwright` (`npm i --no-save playwright`, or point `PLAYWRIGHT_MODULE` at an existing install), ffmpeg, and Python 3 with numpy.

## Render

```bash
cd video/reel
node render.mjs stills 12 37.5        # preview frames → still-12.jpg, still-37.5.jpg
python3 audio.py                     # → sound.wav
node render.mjs silent.mp4            # all 1800 frames → silent.mp4 (several minutes)
ffmpeg -i silent.mp4 -i sound.wav -c:v copy -c:a aac -b:a 192k -shortest spekterm-reel.mp4
```

Outputs (`*.mp4`, `*.wav`, `still-*.jpg`) are git-ignored.
