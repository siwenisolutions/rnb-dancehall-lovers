# Welcome video

Source for `public/video/welcome.mp4`, the tour that opens in the admin panel.

1. `scenes.json`: narration and on-screen caption for each scene. Edit the words here.
2. `tts.py`: makes the voice-over with the offline Kokoro voice (`pip install kokoro-onnx soundfile`;
   put `kokoro.onnx` and `voices.bin` from the kokoro-onnx GitHub releases in `../tts/`).
3. `record.js`: plays each scene in Chromium against a local copy of the site on port 3999
   (demo events created first) and records it with Playwright. Paths at the top may need adjusting.
4. `build.py`: trims the clips, adds the narration and fades, joins them into `welcome.mp4`.
   Then run `ffmpeg -i welcome.mp4 -c:v copy -af loudnorm=I=-16:TP=-1.5 -c:a aac welcome-final.mp4`.

After replacing the video, bump `?v=` on the video and poster links in `public/admin.html`.

## Motion-graphic version (current)

The video in `public/video/welcome.mp4` is the motion-graphic cut: the real site plays inside a
floating browser window, with chapter titles and animated title cards.

1. Record clean screen clips (no captions): `NOCAP=1 CLIPDIR=clips2 MANIFEST=manifest2.json node record.js`
2. `node motion/render.js` draws the background, titles, browser frame and the animated title cards.
3. `python3 motion/compose.py` composites every scene (floating window, sway, fades), adds the
   narration and writes `welcome-motion.mp4` plus its poster.
