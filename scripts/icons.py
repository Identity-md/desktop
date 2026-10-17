"""Draws the app's icons from the IMD mark (the explorer's icon.svg): a square ring around a diamond ring.

Tray icons are template images (black on clear; macOS tints them for the menu bar), 44 px for a 22 pt
bar, drawn at the weight of the system's symbols beside them. The app icon is the mark in black on white,
the explorer's own, from which `tauri icon` makes every size each platform wants.
"""
import json
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

def mark(size: int, pad: float, *, filled=False, dot=False, alpha=255, ink=(0, 0, 0), paper=None) -> Image.Image:
    im = Image.new("RGBA", (size, size), paper or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = (size - 2 * pad) / 32  # the mark's 32-unit grid
    p = lambda x, y: (pad + x * s, pad + y * s)
    color = (*ink, alpha)
    # square ring: 1.5..30.5 with a 3-unit stroke
    d.rectangle([p(0, 0), p(32, 32)], fill=color)
    d.rectangle([p(3, 3), p(29, 29)], fill=paper or (0, 0, 0, 0))
    # diamond ring: centre 16, half-diagonal 7.5 with a 2.6-unit stroke, measured square to its sides as the
    # SVG's stroke is, so its reach along the diagonal is 1.3 x sqrt 2 either side: the weight of the square
    o, i = 7.5 + 1.3 * 2 ** 0.5, 7.5 - 1.3 * 2 ** 0.5
    outer = [p(16, 16 - o), p(16 + o, 16), p(16, 16 + o), p(16 - o, 16)]
    inner = [p(16, 16 - i), p(16 + i, 16), p(16, 16 + i), p(16 - i, 16)]
    d.polygon(outer, fill=color)
    if not filled:
        d.polygon(inner, fill=paper or (0, 0, 0, 0))
    if dot:
        r = 4.2 * s
        cx, cy = p(28.5, 3.5)
        d.ellipse([cx - r - 1.5 * s, cy - r - 1.5 * s, cx + r + 1.5 * s, cy + r + 1.5 * s], fill=(0, 0, 0, 0))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    return im

def supersampled(make, size: int) -> Image.Image:
    big = make(size * 8)
    return big.resize((size, size), Image.LANCZOS)

def bold(size: int, *, filled=False, dot=False, alpha=255, glyph=16.5) -> Image.Image:
    """The mark for a menu bar or tray: the site's mark, square corners and all, at about the weight of the
    system's own symbols beside it (strokes near 1.8 pt at 16.5 pt), the diamond's stroke to the square's as
    the site's icon.svg has them. Working, the diamond fills; wanting attention, a dot sits in the corner,
    cut clear of the square as the system's badge is."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    unit = size / 22 * glyph / 32
    o = (size - 32 * unit) / 2
    p = lambda x, y: (o + x * unit, o + y * unit)
    color = (0, 0, 0, alpha)
    d.rectangle([p(0, 0), p(32, 32)], fill=color)
    d.rectangle([p(3.6, 3.6), p(28.4, 28.4)], fill=(0, 0, 0, 0))
    # the diamond: a ring 3.2 units thick, square to its sides, or a smaller solid one of the same weight
    reach, stroke = (6.2, 3.2) if filled else (7.5, 3.2)
    out, inn = reach + stroke / 2 * 2 ** 0.5, reach - stroke / 2 * 2 ** 0.5
    d.polygon([p(16, 16 - out), p(16 + out, 16), p(16, 16 + out), p(16 - out, 16)], fill=color)
    if not filled:
        d.polygon([p(16, 16 - inn), p(16 + inn, 16), p(16, 16 + inn), p(16 - inn, 16)], fill=(0, 0, 0, 0))
    if dot:
        r, cx, cy = 5.2 * unit, *p(29, 3)
        gap = 2.2 * unit
        d.ellipse([cx - r - gap, cy - r - gap, cx + r + gap, cy + r + gap], fill=(0, 0, 0, 0))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    return im

out = "src-tauri/icons"
supersampled(lambda n: bold(n), 44).save(f"{out}/tray.png")
supersampled(lambda n: bold(n, filled=True), 44).save(f"{out}/tray-working.png")
supersampled(lambda n: bold(n, dot=True), 44).save(f"{out}/tray-attention.png")
supersampled(lambda n: bold(n, alpha=110), 44).save(f"{out}/tray-off.png")

# Windows and Linux do not tint tray icons, and a taskbar is as often dark as light: there the mark sits on
# a white tile, as the app icon does, and says its state with the tile's own colour where it must.
def tile(n: int, *, filled=False, dot=False, grey=False) -> Image.Image:
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=(205, 205, 210, 255) if grey else (255, 255, 255, 255))
    im.alpha_composite(bold(n, filled=filled, glyph=14.5))
    if dot:
        r = n * 0.16
        d = ImageDraw.Draw(im)
        d.ellipse([n - 2 * r - n * 0.04, n * 0.04, n - n * 0.04, n * 0.04 + 2 * r], fill=(242, 154, 10, 255))
    return im

supersampled(lambda n: tile(n), 32).save(f"{out}/tray-tile.png")
supersampled(lambda n: tile(n, filled=True), 32).save(f"{out}/tray-tile-working.png")
supersampled(lambda n: tile(n, dot=True), 32).save(f"{out}/tray-tile-attention.png")
supersampled(lambda n: tile(n, grey=True), 32).save(f"{out}/tray-tile-off.png")

# The app icon: a white tile with the black mark, rounded as each platform rounds its own.
icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
tile = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
ImageDraw.Draw(tile).rounded_rectangle([100, 100, 924, 924], radius=185, fill=(255, 255, 255, 255))
icon.alpha_composite(tile)
icon.alpha_composite(supersampled(lambda n: mark(n, n * 0.30), 1024))
icon.save(f"{out}/app-icon.png")

# The Mac's icon comes from one Icon Composer document, icons/AppIcon.icon: the white square with the mark,
# drawn here as a vector at the size it sits on the tile. actool compiles it into Assets.car, which macOS 26
# draws as its own icon, and an icon.icns of the rounded tile it renders for older macOS. A plain icns can't
# serve both: macOS 26 puts one that keeps its margins on a plate with a glassy bevel, and a full-bleed square
# it rounds itself showed as a hard square on macOS before 26 (both seen in Finder on 2026-10-16). actool
# needs Xcode 26 and its license accepted once (sudo xcodebuild -license accept).
pad = 1024 * 0.26
u = (1024 - 2 * pad) / 32
q = lambda x, y: f"{pad + x * u:.3f} {pad + y * u:.3f}"
o, i = 7.5 + 1.3 * 2 ** 0.5, 7.5 - 1.3 * 2 ** 0.5
square = f"M{q(0, 0)}H{pad + 32 * u:.3f}V{pad + 32 * u:.3f}H{pad:.3f}Z M{q(3, 3)}V{pad + 29 * u:.3f}H{pad + 29 * u:.3f}V{pad + 3 * u:.3f}Z"
diamond = f"M{q(16, 16 - o)}L{q(16 + o, 16)}L{q(16, 16 + o)}L{q(16 - o, 16)}Z M{q(16, 16 - i)}L{q(16 - i, 16)}L{q(16, 16 + i)}L{q(16 + i, 16)}Z"
doc = f"{out}/AppIcon.icon"
os.makedirs(f"{doc}/Assets", exist_ok=True)
with open(f"{doc}/Assets/mark.svg", "w") as f:
    f.write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <path fill="#000" fill-rule="evenodd" d="{square}"/>
  <path fill="#000" fill-rule="evenodd" d="{diamond}"/>
</svg>
''')
with open(f"{doc}/icon.json", "w") as f:
    json.dump({
        "fill": {"solid": "extended-srgb:1.00000,1.00000,1.00000,1.00000"},
        "groups": [{
            "layers": [{"glass": False, "image-name": "mark.svg", "name": "mark"}],
            "shadow": {"kind": "neutral", "opacity": 0},
            "specular": False,
            "translucency": {"enabled": False, "value": 0.5},
        }],
        "supported-platforms": {"squares": "shared"},
    }, f, indent=2)
    f.write("\n")
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(["xcrun", "actool", doc, "--compile", tmp, "--platform", "macosx", "--minimum-deployment-target", "12.0",
                    "--app-icon", "AppIcon", "--output-partial-info-plist", f"{tmp}/partial.plist", "--output-format", "human-readable-text"],
                   check=True, env={**os.environ, "DEVELOPER_DIR": os.environ.get("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")})
    shutil.copy(f"{tmp}/Assets.car", f"{out}/Assets.car")
    shutil.copy(f"{tmp}/AppIcon.icns", f"{out}/icon.icns")
print("icons drawn")
