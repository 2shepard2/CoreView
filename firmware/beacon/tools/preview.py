#!/usr/bin/env python3
"""Turn preview.cpp raw frames into an LED-look animated GIF (and a PNG strip).
usage: preview.py in.raw out.gif [scale]"""
import sys
from PIL import Image, ImageDraw

W, H = 96, 32


def led_frame(data, s):
    img = Image.new("RGB", (W * s, H * s), (8, 8, 10))
    d = ImageDraw.Draw(img)
    for y in range(H):
        for x in range(W):
            k = (y * W + x) * 3
            r, g, b = data[k], data[k + 1], data[k + 2]
            if r or g or b:
                d.ellipse([x * s + 1, y * s + 1, x * s + s - 2, y * s + s - 2], fill=(r, g, b))
            else:
                d.ellipse([x * s + 2, y * s + 2, x * s + s - 3, y * s + s - 3], fill=(18, 18, 22))
    return img


def main():
    src, dst = sys.argv[1], sys.argv[2]
    s = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    raw = open(src, "rb").read()
    n = len(raw) // (W * H * 3)
    step = 2  # 37 fps source -> ~18 fps GIF keeps files small
    frames = [led_frame(raw[i * W * H * 3:(i + 1) * W * H * 3], s) for i in range(0, n, step)]
    frames[0].save(dst, save_all=True, append_images=frames[1:], duration=int(1000 / 37 * step), loop=0, optimize=False)
    strip = Image.new("RGB", (W * s, H * s * 4 + 30), (0, 0, 0))
    for j, i in enumerate([n // 8, n * 3 // 8, n * 5 // 8, n * 7 // 8]):
        strip.paste(led_frame(raw[i * W * H * 3:(i + 1) * W * H * 3], s), (0, j * (H * s + 10)))
    strip.save(dst.rsplit(".", 1)[0] + ".png")
    print(dst, n, "frames")


main()
