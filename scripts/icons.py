"""Draws the app's icons from the IMD mark (the explorer's icon.svg): a square ring around a diamond ring.

Tray icons are template images (black on clear; macOS tints them for the menu bar), 44 px for a 22 pt
bar. The app icon is the mark in black on white, the explorer's own, from which `tauri icon` makes
every size each platform wants.
"""
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
    # diamond ring: centre 16, half-diagonal 7.5 with a 2.6-unit stroke
    outer = [p(16, 16 - 8.8), p(16 + 8.8, 16), p(16, 16 + 8.8), p(16 - 8.8, 16)]
    inner = [p(16, 16 - 6.2), p(16 + 6.2, 16), p(16, 16 + 6.2), p(16 - 6.2, 16)]
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

out = "src-tauri/icons"
supersampled(lambda n: mark(n, n * 0.14), 44).save(f"{out}/tray.png")
supersampled(lambda n: mark(n, n * 0.14, filled=True), 44).save(f"{out}/tray-working.png")
supersampled(lambda n: mark(n, n * 0.14, dot=True), 44).save(f"{out}/tray-attention.png")
supersampled(lambda n: mark(n, n * 0.14, alpha=110), 44).save(f"{out}/tray-off.png")

# Windows and Linux do not tint tray icons, and a taskbar is as often dark as light: there the mark sits on
# a white tile, as the app icon does, and says its state with the tile's own colour where it must.
def tile(n: int, *, filled=False, dot=False, grey=False) -> Image.Image:
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=(205, 205, 210, 255) if grey else (255, 255, 255, 255))
    im.alpha_composite(mark(n, n * 0.2, filled=filled))
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
print("icons drawn")
