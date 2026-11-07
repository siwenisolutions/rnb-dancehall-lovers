"""Composite the motion-graphic welcome video: floating browser window scenes,
animated title cards, narration, fades; then join and normalise loudness."""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
VID = os.path.join(HERE, '..', 'video')
L = os.path.join(HERE, 'layers')
scenes = json.load(open(os.path.join(VID, 'scenes.json')))
cards_manifest = json.load(open(os.path.join(VID, 'manifest.json')))
clips = json.load(open(os.path.join(VID, 'manifest2.json')))
CARDS = {'01-welcome', '09-capabilities', '16-goodbye'}
ADMIN = {'10-login', '11-overview', '12-add-event', '13-event-photos', '14-photos', '15-details'}
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)


def run(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y'] + args, check=True)


parts = []
for s in scenes:
    sid = s['id']
    visual = os.path.join(HERE, 'out', sid + '-v.mp4')
    if sid in CARDS:
        length = round(cards_manifest[sid]['len'], 2)
        visual = os.path.join(HERE, f'card-{sid}.mp4')
    else:
        c = clips[sid]
        length = round(c['len'], 2)
        bezel = os.path.join(L, 'bezel-admin.png' if sid in ADMIN else 'bezel-site.png')
        fc = (
            f"[4:v]fps=30,scale=880:495:flags=lanczos,format=rgba[scr];"
            f"[3:v]format=gray,scale=880:495[m];"
            f"[scr][m]alphamerge[scrA];"
            f"color=c=0x00000000:s=960x600:r=30:d={length},format=rgba[cv];"
            f"[cv][scrA]overlay=40:60:shortest=1[d1];"
            f"[d1][2:v]overlay=0:0[dev];"
            # the window sways gently and fades in as it rises into place
            f"[dev]rotate=a='0.0095*sin(2*PI*t/7)':c=none:ow=iw:oh=ih,fade=t=in:st=0:d=0.6:alpha=1[devr];"
            f"[1:v]format=rgba,fade=t=in:st=0.1:d=0.6:alpha=1[ti];"
            f"[0:v]fps=30,format=rgba[bgv];"
            f"[bgv][ti]overlay=x=0:y='18*pow(max(0\\,1-(t-0.1)/0.7)\\,2)':eval=frame[b1];"
            f"[b1][devr]overlay=x=160:y='120+7*sin(2*PI*t/5.5)+60*pow(max(0\\,1-t/0.8)\\,3)':eval=frame:shortest=1,"
            f"trim=duration={length},format=yuv420p[v]"
        )
        run([
            '-loop', '1', '-framerate', '30', '-i', os.path.join(L, 'bg.png'),
            '-loop', '1', '-framerate', '30', '-i', os.path.join(L, f'title-{sid}.png'),
            '-loop', '1', '-framerate', '30', '-i', bezel,
            '-loop', '1', '-framerate', '30', '-i', os.path.join(L, 'mask.png'),
            '-ss', str(c['offset']), '-t', str(length), '-i', c['file'],
            '-filter_complex', fc, '-map', '[v]', '-t', str(length),
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', visual,
        ])
    # narration starts 0.35s in; scene fades in/out
    part = os.path.join(HERE, 'out', sid + '.mp4')
    run([
        '-i', visual, '-i', os.path.join(VID, 'audio', sid + '.wav'),
        '-vf', f"fps=30,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st={length - 0.3}:d=0.3",
        '-af', f"adelay=350|350,apad,atrim=0:{length},afade=t=out:st={length - 0.25}:d=0.25,aresample=48000",
        '-map', '0:v', '-map', '1:a', '-t', str(length),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', part,
    ])
    parts.append(part)
    print('scene', sid, length)

lst = os.path.join(HERE, 'out', 'parts.txt')
with open(lst, 'w') as f:
    for p in parts:
        f.write(f"file '{p}'\n")
joined = os.path.join(HERE, 'out', 'joined.mp4')
run(['-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined])
final = os.path.join(HERE, 'welcome-motion.mp4')
run(['-i', joined, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '128k',
     '-ar', '48000', '-movflags', '+faststart', final])
run(['-ss', '2.6', '-i', final, '-frames:v', '1', '-q:v', '3', os.path.join(HERE, 'welcome-motion-poster.jpg')])
print('done', final)
