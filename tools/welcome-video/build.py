"""Trim each recorded clip, add its narration and fades, then join into one MP4."""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
m = json.load(open(os.path.join(HERE, 'manifest.json')))
scenes = json.load(open(os.path.join(HERE, 'scenes.json')))
os.makedirs(os.path.join(HERE, 'parts'), exist_ok=True)
FADE = 0.3
parts = []
for s in scenes:
    c = m[s['id']]
    length = round(c['len'], 2)
    out = os.path.join(HERE, 'parts', s['id'] + '.mp4')
    vf = (f"fps=30,scale=1280:720,format=yuv420p,"
          f"fade=t=in:st=0:d={FADE},fade=t=out:st={length - FADE}:d={FADE}")
    # narration starts 0.35s into the scene; silence pads the rest
    af = f"adelay=350|350,apad,atrim=0:{length},afade=t=out:st={length - 0.25}:d=0.25,aresample=48000"
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y',
        '-ss', str(c['offset']), '-t', str(length), '-i', c['file'],
        '-i', os.path.join(HERE, 'audio', s['id'] + '.wav'),
        '-vf', vf, '-af', af, '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-t', str(length), out,
    ], check=True)
    parts.append(out)
    print('built', s['id'], length)

lst = os.path.join(HERE, 'parts.txt')
with open(lst, 'w') as f:
    for p in parts:
        f.write(f"file '{p}'\n")
final = os.path.join(HERE, 'welcome.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
                '-c', 'copy', '-movflags', '+faststart', final], check=True)
# Poster image for the player (the welcome card).
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '3', '-i', final, '-frames:v', '1', '-q:v', '3',
                os.path.join(HERE, 'welcome-poster.jpg')], check=True)
print('done', final)
