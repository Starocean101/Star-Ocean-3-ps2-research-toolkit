#!/usr/bin/env python3
"""Generate runtime assets for Star Ocean Utility Tool:
  - bg.bin   : 1920x1080 background, raw RGB (from the nebula image)
  - music.pcm: ~24 s looping ambient pad, 48 kHz mono signed-16 PCM
  - icon0.png: 512x512 app icon (nebula crop + title)
"""
import sys
import struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads/2e07e0fe-image.jpg"
OUT = sys.argv[2] if len(sys.argv) > 2 else "assets"

W, H = 1920, 1080

# ---------- background ----------
img = Image.open(SRC).convert("RGB")
# cover-fit to 1920x1080
sw, sh = img.size
scale = max(W / sw, H / sh)
img = img.resize((int(sw * scale + 0.5), int(sh * scale + 0.5)), Image.LANCZOS)
left = (img.width - W) // 2
top = (img.height - H) // 2
img = img.crop((left, top, left + W, top + H))
# darken slightly so white UI text stays readable
arr = np.asarray(img).astype(np.float32)
arr *= 0.72
img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
with open(f"{OUT}/bg.bin", "wb") as f:
    f.write(img.tobytes())  # RGB, row-major, 1920*1080*3 bytes
print("bg.bin", W, H, img.width * img.height * 3, "bytes")

# ---------- icon ----------
icon = Image.open(SRC).convert("RGB")
s = min(icon.size)
icon = icon.crop(((icon.width - s) // 2, (icon.height - s) // 2,
                  (icon.width - s) // 2 + s, (icon.height - s) // 2 + s)).resize((512, 512), Image.LANCZOS)
d = ImageDraw.Draw(icon)
# subtle dark gradient at the bottom for the title
grad = Image.new("L", (1, 512), 0)
for y in range(512):
    grad.putpixel((0, y), int(200 * max(0, (y - 300) / 212)))
grad = grad.resize((512, 512))
black = Image.new("RGB", (512, 512), (4, 8, 24))
icon = Image.composite(black, icon, grad)
d = ImageDraw.Draw(icon)
star = "★"
try:
    fbig = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 300)
    fsub = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 52)
    fsm = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
except Exception:
    fbig = fsub = fsm = ImageFont.load_default()
# glowing star mark
star_layer = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
ds = ImageDraw.Draw(star_layer)
w = ds.textlength(star, font=fbig)
ds.text(((512 - w) / 2, 40), star, font=fbig, fill=(120, 200, 255, 255))
glow = star_layer.filter(ImageFilter.GaussianBlur(14))
icon = Image.alpha_composite(icon.convert("RGBA"), glow)
icon = Image.alpha_composite(icon, star_layer).convert("RGB")
d = ImageDraw.Draw(icon)
for txt, f, y in [("STAR OCEAN", fsub, 388), ("Utility Tool", fsm, 452)]:
    w = d.textlength(txt, font=f)
    d.text(((512 - w) / 2 + 2, y + 2), txt, font=f, fill=(0, 0, 0))
    d.text(((512 - w) / 2, y), txt, font=f, fill=(235, 245, 255))
icon.save(f"{OUT}/icon0.png")
print("icon0.png saved")

# ---------- ambient music ----------
SR = 48000
DUR = 24.0
n = int(SR * DUR)
t = np.arange(n) / SR

def note(freq, amp):
    # soft detuned sine pad with slow vibrato + a quiet 5th and octave
    vib = 1.0 + 0.0015 * np.sin(2 * np.pi * 0.12 * t)
    base = np.sin(2 * np.pi * freq * vib * t)
    fifth = 0.35 * np.sin(2 * np.pi * freq * 1.5 * vib * t)
    octave = 0.18 * np.sin(2 * np.pi * freq * 2.0 * t)
    detune = 0.3 * np.sin(2 * np.pi * (freq * 1.003) * t)
    return amp * (base + detune + fifth + octave)

# gentle Am - F - C - G style progression (A2,F2,C3,G2 roots), 6 s each
roots = [110.00, 87.31, 130.81, 98.00]
seg = n // len(roots)
audio = np.zeros(n, dtype=np.float32)
for i, fr in enumerate(roots):
    a, b = i * seg, (i + 1) * seg if i < len(roots) - 1 else n
    m = b - a
    env = np.ones(m)
    fade = int(SR * 1.5)
    env[:fade] = np.linspace(0, 1, fade)      # soft attack
    env[-fade:] = np.linspace(1, 0, fade)     # soft release (crossfade-friendly)
    audio[a:b] += (note(fr, 0.5)[:m] * env).astype(np.float32)

# add a very quiet high shimmer pad an octave up
audio += (0.08 * np.sin(2 * np.pi * 523.25 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.05 * t))).astype(np.float32)

# normalize softly and make loop seamless (crossfade tail into head)
audio /= np.max(np.abs(audio)) + 1e-6
audio *= 0.55
xf = int(SR * 1.5)
head = audio[:xf].copy()
tail = audio[-xf:].copy()
ramp = np.linspace(0, 1, xf)
audio[-xf:] = tail * (1 - ramp) + head * ramp
audio = audio[:-xf]  # drop duplicated head region so the join is clean

pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2")
with open(f"{OUT}/music.pcm", "wb") as f:
    f.write(pcm.tobytes())
print("music.pcm", len(pcm), "samples (mono s16 @48k)", len(pcm) * 2, "bytes")
