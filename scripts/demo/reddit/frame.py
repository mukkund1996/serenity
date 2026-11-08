"""
Frames the raw recording (reddit.tape): a camera that zooms in on the master
or a card and pans between them, a caption band at the bottom, the dull
stretches cut, and an end card with the logo.

    uv run --with pillow python scripts/demo/reddit/frame.py           # out/reddit.mp4 + .gif, 1080 square
    uv run --with pillow python scripts/demo/reddit/frame.py readme    # docs/demo.gif, 1280 x 720

SEGMENTS, SHOTS and CAPTIONS are in seconds of out/raw.mp4; re-check them
against its frames after re-recording, since the tape waits on the screen.
"""

import math
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
OUT = HERE / "out"
RAW = OUT / "raw.mp4"
SRC_W, SRC_H = 2950, 1610
FPS = 24

BG = (13, 15, 18)
GREEN = (127, 199, 127)  # serenity's accent (#7fc77f)
FG = (232, 234, 238)
MUTED = (133, 140, 151)
CARD_FADE = 0.4  # the cross-fade into the end card
CARD_HOLD = 1.8

# The parts of the raw recording kept, in order, and how fast each plays.
SEGMENTS = [
    (3.0, 5.2, 1.0),  # NEEDS YOU full from the first frame (the thumbnail)
    (5.5, 8.3, 1.0),  # Tab to Priya's request; the camera moves to orders db
    (9.4, 11.8, 1.0),  # y; fix-csv-export lands and is filed
    (13.4, 15.4, 1.3),  # back to the master
    (15.9, 24.6, 1.3),  # @new, typed, and its reply
    (26.1, 33.0, 1.3),  # @fix-csv-export, typed, and its reply
    (35.1, 38.2, 1.0),  # x clears NEEDS YOU as the camera pulls out
]


@dataclass
class Profile:
    w: int
    h: int
    band: int  # the caption band's height, under the view
    font: int
    gif_fps: int
    gif_colours: int
    lossy: int
    # Where the camera looks: (centre x, centre y, width), in raw pixels.
    master: tuple[float, float, float]
    card: tuple[float, float, float]  # the orders db topic, where fix-csv-export lands
    calm: tuple[float, float, float]  # the whole map, nothing needing you


PROFILES = {
    "reddit": Profile(1080, 1080, 160, 66, 12, 64, 80,
                      master=(1466, 812, 1170), card=(445, 995, 860), calm=(1475, 820, 2980)),
    "readme": Profile(1280, 720, 90, 46, 10, 64, 60,
                      master=(1466, 805, 2030), card=(660, 995, 1420), calm=(1475, 805, 3260)),
}


def shots(p: Profile) -> list[tuple[float, tuple[float, float, float]]]:
    """(time, view): the camera holds a view, then eases to the next."""
    return [
        (0.0, p.master),
        (6.6, p.master),
        (7.8, p.card),  # on the topic before y (at 9.7), so the card lands on camera
        (13.5, p.card),
        (15.0, p.master),  # settled before i and the typing (16.0)
        (35.2, p.master),
        (37.4, p.calm),  # pulls out while x clears NEEDS YOU (35.8 to 37.0)
    ]


# Each ends where its segment does, so it fades out before the cut.
CAPTIONS = [
    (0.0, 5.2, "Everything that needs you"),
    (5.5, 8.3, "Team asks for a fix"),
    (9.4, 10.8, "y to approve"),
    (10.8, 15.4, "Master starts session"),
    (15.9, 24.6, "Use @ commands"),
    (26.1, 33.0, "Ping on Slack when done"),
    (35.1, 99, "One calm map for everything"),
]

CAPTION_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
SERIF = "/System/Library/Fonts/NewYork.ttf"
MONO = "/System/Library/Fonts/Menlo.ttc"
FADE = 0.25


def ease(x: float) -> float:
    return 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, x)))


def view_at(plan, t: float) -> tuple[float, float, float]:
    for (t0, a), (t1, b) in zip(plan, plan[1:]):
        if t < t1:
            k = ease((t - t0) / (t1 - t0)) if t >= t0 else 0.0
            # Zoom in log space, so it feels even.
            w = math.exp(math.log(a[2]) + (math.log(b[2]) - math.log(a[2])) * k)
            return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, w)
    return plan[-1][1]


def caption(t: float) -> tuple[str, float] | None:
    for t0, t1, text in CAPTIONS:
        if t0 <= t < t1:
            fade_in = (t - t0) / FADE if t0 > 0 else 1.0
            return text, max(0.0, min(1.0, fade_in, (t1 - t) / FADE))
    return None


def render(p: Profile, plan, font, src: Image.Image, t: float) -> Image.Image:
    view_h = p.h - p.band
    cx, cy, w = view_at(plan, t)
    h = w * view_h / p.w
    x0, y0 = cx - w / 2, cy - h / 2
    # Pillow wants the box inside the image: pad the raw frame when the view leaves it.
    spill = max(-x0, -y0, x0 + w - SRC_W, y0 + h - SRC_H)
    if spill > 0:
        pad = math.ceil(spill) + 2
        big = Image.new("RGB", (SRC_W + 2 * pad, SRC_H + 2 * pad), BG)
        big.paste(src, (pad, pad))
        src, x0, y0 = big, x0 + pad, y0 + pad
    frame = Image.new("RGB", (p.w, p.h), BG)
    frame.paste(src.resize((p.w, view_h), Image.LANCZOS, box=(x0, y0, x0 + w, y0 + h)), (0, 0))
    cap = caption(t)
    if cap:
        text, alpha = cap
        d = ImageDraw.Draw(frame)
        box = d.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        colour = tuple(int(BG[i] + (c - BG[i]) * alpha) for i, c in enumerate(GREEN))
        d.text(((p.w - tw) / 2 - box[0], view_h + (p.band - th) / 2 - box[1] - p.band * 0.06), text,
               font=font, fill=colour)
    return frame


def centred(d: ImageDraw.ImageDraw, y: float, text: str, font: ImageFont.FreeTypeFont, fill) -> None:
    box = d.textbbox((0, 0), text, font=font)
    d.text(((d.im.size[0] - (box[2] - box[0])) / 2 - box[0], y - box[1]), text, font=font, fill=fill)


def end_card(p: Profile) -> Image.Image:
    """The logo (website/favicon.svg), the name, the tagline and the site, as on og.png."""
    s = 4  # drawn large, then scaled down, for smooth edges
    k = min(p.w, p.h) / 1080 * s  # layout units: a 1080 square
    img = Image.new("RGB", (p.w * s, p.h * s), BG)
    d = ImageDraw.Draw(img)
    oy = (p.h * s - 1080 * k) / 2  # centre the square layout vertically
    tile, top = 200 * k, oy + 250 * k
    left = (p.w * s - tile) / 2
    d.rounded_rectangle((left, top, left + tile, top + tile), radius=tile * 14 / 64, fill=(24, 28, 33))
    u = tile / 64
    cx, cy = left + 32 * u, top + 32 * u

    def diamond(r: float) -> list[tuple[float, float]]:
        return [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]

    d.polygon(diamond(22 * u), outline=GREEN, width=round(4 * u))
    d.polygon(diamond(9 * u), fill=GREEN)
    centred(d, oy + 520 * k, "serenity", ImageFont.truetype(SERIF, round(150 * k)), FG)
    tagline = ImageFont.truetype(SERIF, round(54 * k))
    centred(d, oy + 740 * k, "One calm map for your", tagline, (181, 186, 194))
    centred(d, oy + 810 * k, "Claude Code sessions.", tagline, (181, 186, 194))
    centred(d, oy + 940 * k, "getserenity.dev", ImageFont.truetype(MONO, round(34 * k)), MUTED)
    return img.resize((p.w, p.h), Image.LANCZOS)


def main(name: str) -> None:
    p = PROFILES[name]
    plan = shots(p)
    font = ImageFont.truetype(CAPTION_FONT, p.font)
    mp4 = OUT / f"{name}.mp4"
    decode = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(RAW), "-vf", f"fps={FPS}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    encode = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{p.w}x{p.h}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)],
        stdin=subprocess.PIPE,
    )
    size = SRC_W * SRC_H * 3
    at, raw = -1, b""  # the raw frame read last, and its index

    def raw_frame(t: float) -> Image.Image:
        nonlocal at, raw
        while at < round(t * FPS):
            chunk = decode.stdout.read(size)
            if len(chunk) < size:
                break
            raw, at = chunk, at + 1
        return Image.frombytes("RGB", (SRC_W, SRC_H), raw)

    n, last = 0, None
    for r0, r1, speed in SEGMENTS:
        for i in range(round((r1 - r0) / speed * FPS)):
            t = r0 + i * speed / FPS
            last = render(p, plan, font, raw_frame(t), t)
            encode.stdin.write(last.tobytes())
            n += 1
    card = end_card(p)
    fade = round(CARD_FADE * FPS)
    for i in range(fade + round(CARD_HOLD * FPS)):
        encode.stdin.write(Image.blend(last, card, min(1.0, (i + 1) / fade)).tobytes())
        n += 1
    encode.stdin.close()
    encode.wait()
    decode.kill()  # the tail of the raw recording is not used
    decode.wait()
    print(f"{mp4}: {n} frames, {n / FPS:.1f} s", file=sys.stderr)

    gif = HERE.parents[2] / "docs" / "demo.gif" if name == "readme" else OUT / f"{name}.gif"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-filter_complex",
         f"fps={p.gif_fps},split[a][b];[a]palettegen=max_colors={p.gif_colours}:stats_mode=diff[p];"
         # Terminal colours are flat: dithering only adds noise.
         "[b][p]paletteuse=dither=none:diff_mode=rectangle", str(gif)],
        check=True,
    )
    subprocess.run(["gifsicle", "-O3", f"--lossy={p.lossy}", "-b", str(gif)], check=True)
    print(gif, file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "reddit")
