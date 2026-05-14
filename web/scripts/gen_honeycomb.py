"""
Emit web/public/honeycomb-gradient.svg — a single non-repeating background
asset for the app. Pointy-top hex grid where the hexagons grow in size from
the top of the canvas (tiny dots) to the bottom (full honeycomb cells).
"""
from __future__ import annotations
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "public", "honeycomb-gradient.svg"))

# Canvas. Wide-ish 16:9 so it scales cleanly to either phone or desktop
# when used as `background-size: cover`.
W, H = 1600, 1200

# Hex-radius extremes. The grid spacing is fixed (set by R_MAX) so smaller
# hexes leave whitespace around them — that's what creates the "fading dots"
# look at the small end.
R_MIN = 0.8
R_MAX = 28.0
GRID_PADDING_FACTOR = 0.93  # squeeze cells a hair so big hexes don't touch

DX = R_MAX * math.sqrt(3) * GRID_PADDING_FACTOR
DY = R_MAX * 1.5 * GRID_PADDING_FACTOR

COLOR = "#b45309"  # amber-700
ACCENT = "#f59e0b"  # amber-500 — sprinkle a few of these for warmth
ACCENT_RATE = 1 / 40  # ~2.5% of hexes use the accent colour


def hex_points(cx: float, cy: float, r: float) -> str:
    pts: list[str] = []
    for i in range(6):
        a = math.pi / 3 * i - math.pi / 2  # pointy-top, start at 12 o'clock
        pts.append(f"{cx + r*math.cos(a):.1f},{cy + r*math.sin(a):.1f}")
    return " ".join(pts)


def main() -> int:
    hexes: list[str] = []
    row = 0
    y = -DY  # start slightly above so partial hexes don't leave gaps
    rng_state = 0x1234abcd  # deterministic LCG so the accent placement is stable
    while y < H + DY:
        x_offset = (row % 2) * (DX / 2)
        x = -DX + x_offset
        while x < W + DX:
            # t is 0 at the top edge, 1 at the bottom edge — that's the rotation
            # the user wanted (vertical small→big gradient).
            t = max(0.0, min(1.0, y / H))
            # Ease-in so the tiny side stays really tiny for a while and the
            # growth ramps quickly near the bottom.
            t_eased = t * t
            r = R_MIN + (R_MAX - R_MIN) * t_eased
            opacity = 0.12 + 0.32 * t_eased  # 12% at top, 44% at bottom
            # Deterministic accent picker
            rng_state = (rng_state * 1103515245 + 12345) & 0x7FFFFFFF
            is_accent = (rng_state % 40) == 0
            fill = ACCENT if is_accent else COLOR
            hexes.append(
                f'<polygon points="{hex_points(x, y, r)}" fill="{fill}" fill-opacity="{opacity:.2f}"/>'
            )
            x += DX
        y += DY
        row += 1

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMax slice">'
        f'<g>{"".join(hexes)}</g></svg>'
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(svg)
    size_kb = round(os.path.getsize(OUT) / 1024, 1)
    print(f"wrote {OUT} ({len(hexes)} hexes, {size_kb} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
