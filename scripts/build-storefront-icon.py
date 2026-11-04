"""
Draw the storefront icon for the plugin.

The marketplace refuses SVG and draws the tile at ~96px, so this produces a
square PNG at 512px and 256px: a bell on a dark rounded square, which is the
"attention / notification" idea the plugin is about, drawn from scratch rather
than reusing any application artwork.
"""

from PIL import Image, ImageDraw
import math

SIZE = 512
SCALE = 4  # supersample, then downscale for smooth edges
W = SIZE * SCALE


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_icon():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background: rounded square with a vertical gradient.
    bg = Image.new("RGB", (W, W), (0, 0, 0))
    bd = ImageDraw.Draw(bg)
    top = (26, 32, 62)
    bottom = (58, 44, 110)
    for y in range(W):
        t = y / (W - 1)
        bd.line(
            [(0, y), (W, y)],
            fill=(
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )

    mask = Image.new("L", (W, W), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
    img.paste(bg, (0, 0), mask)

    # --- bell ---
    cx = W / 2
    cream = (245, 240, 232, 255)
    accent = (255, 176, 92, 255)

    body_top = W * 0.26
    body_bottom = W * 0.63
    body_half = W * 0.155

    # Bell body: a dome whose sides flare slightly outward at the bottom.
    pts_left = []
    pts_right = []
    steps = 240
    for i in range(steps + 1):
        t = i / steps
        y = body_top + (body_bottom - body_top) * t
        # Dome profile; eases from a point at the top to full width at the bottom.
        flare = math.sin(t * math.pi / 2) ** 0.62
        half = body_half * flare
        pts_left.append((cx - half, y))
        pts_right.append((cx + half, y))
    d.polygon(pts_left + list(reversed(pts_right)), fill=cream)

    # Base bar of the bell.
    bar_y = body_bottom
    bar_h = W * 0.045
    d.rounded_rectangle(
        [cx - body_half * 1.16, bar_y - bar_h * 0.5, cx + body_half * 1.16, bar_y + bar_h * 0.5],
        radius=int(bar_h * 0.5),
        fill=cream,
    )

    # Clapper.
    r = W * 0.042
    d.ellipse([cx - r, bar_y + bar_h * 0.52 - r, cx + r, bar_y + bar_h * 0.52 + r], fill=cream)

    # Top knob.
    kr = W * 0.030
    d.ellipse([cx - kr, body_top - kr * 1.5, cx + kr, body_top + kr * 0.5], fill=cream)

    # --- attention marks, right of the bell ---
    for i, (radius, width, alpha) in enumerate(
        [(0.150, 0.022, 255), (0.215, 0.020, 190), (0.278, 0.017, 120)]
    ):
        rr = W * radius
        wd = int(W * width)
        start = -58
        end = 58
        d.arc(
            [cx - rr, W * 0.44 - rr, cx + rr, W * 0.44 + rr],
            start=start,
            end=end,
            fill=(accent[0], accent[1], accent[2], alpha),
            width=wd,
        )

    return img.resize((SIZE, SIZE), Image.LANCZOS)


img = draw_icon()
img.save("assets/icon-512.png")
img.resize((256, 256), Image.LANCZOS).save("assets/icon-256.png")
print("wrote assets/icon-512.png and assets/icon-256.png")
