#!/usr/bin/env python3
"""Generates the two icon assets this phase needs, deterministically.

No dependency beyond the Python 3 standard library (zlib for PNG's DEFLATE
compression) -- Pillow is not assumed to be installed wherever this script is
re-run later. A simple concentric-circle "lens" mark: a filled camera-lens
shape, thematically fitting a dslrBooth Agent icon, opaque and square so it
survives electron-builder's rcedit resource embedding (10-RESEARCH R1/Pitfall 2)
without any transparency-handling surprises.

Run: python3 scripts/make-icon.py
Produces:
  build/icon.png          -- 256x256, the application icon (packaging config,
                              NOT copied into the renderer build output)
  src/renderer/tray.png    -- 32x32, the tray icon (copied verbatim into
                              dist/renderer by scripts/copy-assets.js -- the
                              tray icon must live here, not in build/, because
                              electron-builder's packaging step does not ship
                              build/ inside the installed application)
"""
import os
import struct
import zlib

BACKGROUND = (15, 23, 42, 255)      # slate-900 -- flat, opaque, no transparency edge cases
LENS_RING = (37, 99, 235, 255)      # blue-600
LENS_GLASS = (226, 232, 240, 255)   # slate-200
LENS_CENTER = (15, 23, 42, 255)     # slate-900 again -- the aperture


def pixel(x: int, y: int, size: int):
    cx = cy = size / 2
    dx, dy = x - cx + 0.5, y - cy + 0.5
    dist = (dx * dx + dy * dy) ** 0.5
    r = dist / size
    if r < 0.46:
        if r < 0.34:
            if r < 0.14:
                return LENS_CENTER
            return LENS_GLASS
        return LENS_RING
    return BACKGROUND


def write_png(path: str, size: int) -> None:
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0 (none) for every scanline
        for x in range(size):
            row.extend(pixel(x, y, size))
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, level=9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    project_root = os.path.join(os.path.dirname(__file__), "..")
    write_png(os.path.join(project_root, "build", "icon.png"), 256)
    write_png(os.path.join(project_root, "src", "renderer", "tray.png"), 32)
    print("make-icon: wrote build/icon.png (256x256) and src/renderer/tray.png (32x32)")
