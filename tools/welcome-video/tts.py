"""Generate one narration WAV per scene and write durations.json."""
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
tts = os.path.join(here, '..', 'tts')
k = Kokoro(os.path.join(tts, 'kokoro.onnx'), os.path.join(tts, 'voices.bin'))
scenes = json.load(open(os.path.join(here, 'scenes.json')))
voice = sys.argv[1] if len(sys.argv) > 1 else 'af_heart'
os.makedirs(os.path.join(here, 'audio'), exist_ok=True)
durations = {}
for s in scenes:
    samples, sr = k.create(s['say'], voice=voice, speed=0.98, lang='en-us')
    path = os.path.join(here, 'audio', s['id'] + '.wav')
    sf.write(path, samples, sr)
    durations[s['id']] = round(len(samples) / sr, 2)
    print(s['id'], durations[s['id']])
json.dump(durations, open(os.path.join(here, 'durations.json'), 'w'), indent=1)
print('total', round(sum(durations.values()), 1))
