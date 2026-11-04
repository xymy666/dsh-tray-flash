"""
Compose the storefront screenshot from the two captured tray states.

`probe-blank-states.mjs` freezes each blink state and captures it from the live
notification area. This puts them side by side with labels so the market card
shows what the plugin actually does: the icon is there, then it is gone.

    node scripts/probe-blank-states.mjs <pid>   # writes assets/blank-states/
    python scripts/make-screenshot.py           # writes assets/screenshot-tray.png
"""

import os
from PIL import Image, ImageDraw, ImageFont

SRC = os.path.join("assets", "blank-states")
OUT = os.path.join("assets", "screenshot-tray.png")

ZOOM = 7
PAD = 44
LABEL_H = 58


def load(name):
    path = os.path.join(SRC, name)
    if not os.path.exists(path):
        raise SystemExit(f"missing {path}; run probe-blank-states.mjs first")
    return Image.open(path).convert("RGB")


def font(size):
    for name in ("seguisb.ttf", "segoeui.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    normal = load("state-normal.png")
    blank = load("state-blank.png")

    w, h = normal.size
    tile_w, tile_h = w * ZOOM, h * ZOOM

    total_w = PAD * 2 + tile_w * 2 + 90
    total_h = PAD * 2 + LABEL_H + tile_h

    canvas = Image.new("RGB", (total_w, total_h), (14, 18, 32))
    d = ImageDraw.Draw(canvas)

    f_label = font(26)
    f_small = font(19)

    def paste_tile(img, x, title, sub):
        big = img.resize((tile_w, tile_h), Image.NEAREST)
        canvas.paste(big, (x, PAD + LABEL_H))
        d.text((x, PAD), title, font=f_label, fill=(238, 240, 248))
        d.text((x, PAD + 32), sub, font=f_small, fill=(140, 150, 172))

    paste_tile(normal, PAD, "Icon visible", "the app's own icon")

    arrow_x = PAD + tile_w + 20
    mid_y = PAD + LABEL_H + tile_h // 2
    d.line([(arrow_x, mid_y), (arrow_x + 46, mid_y)], fill=(255, 176, 92), width=5)
    d.polygon(
        [(arrow_x + 46, mid_y - 11), (arrow_x + 46, mid_y + 11), (arrow_x + 62, mid_y)],
        fill=(255, 176, 92),
    )

    paste_tile(blank, arrow_x + 70, "Icon hidden", "a fully transparent frame")

    canvas.save(OUT)
    print(f"wrote {OUT} ({total_w}x{total_h})")


if __name__ == "__main__":
    main()
