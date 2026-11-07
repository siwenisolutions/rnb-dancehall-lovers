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
