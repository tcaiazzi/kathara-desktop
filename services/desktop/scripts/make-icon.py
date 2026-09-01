#!/usr/bin/env python3
"""Regenerate resources/icon.png from the frontend's Kathara logo.

Crops the isometric-boxes mark off the left of the wordmark, centres it on a square transparent
canvas and upscales it to 1024x1024. Pure standard library on purpose: no Pillow or ImageMagick
is needed to rebuild the icon. Run from services/desktop:

    python3 scripts/make-icon.py
"""
import os
import struct
import sys
import zlib

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "src", "assets", "kathara-logo.png")
OUT = os.path.join(os.path.dirname(__file__), "..", "resources", "icon.png")
SIZE = 1024
# The wordmark begins after the first wide transparent gap in the source (x = 221..238).
MARK_LIMIT = 235
MARGIN = 0.05


def read_png(path):
    blob = open(path, "rb").read()
    assert blob[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, meta = 8, bytearray(), {}
    while pos < len(blob):
        (length,) = struct.unpack_from(">I", blob, pos)
        tag = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype, _c, _f, interlace = struct.unpack(">IIBBBBB", data)
            meta = dict(w=w, h=h, depth=depth, ctype=ctype, interlace=interlace)
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            break
        pos += 12 + length
    assert meta["depth"] == 8 and meta["interlace"] == 0 and meta["ctype"] == 6, meta
    raw = zlib.decompress(bytes(idat))
    w, h, stride = meta["w"], meta["h"], meta["w"] * 4
    rows, prev, pos = [], bytearray(stride), 0
    for _ in range(h):
        ftype = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            if ftype == 1: line[i] = (line[i] + a) & 0xFF
            elif ftype == 2: line[i] = (line[i] + b) & 0xFF
            elif ftype == 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        rows.append(bytes(line)); prev = line
    return w, h, rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b""))


def main():
    w, h, rows = read_png(SRC)
    alpha = lambda x, y: rows[y][x * 4 + 3]

    xs = [x for x in range(min(MARK_LIMIT, w)) if any(alpha(x, y) > 16 for y in range(h))]
    ys = [y for y in range(h) if any(alpha(x, y) > 16 for x in range(min(MARK_LIMIT, w)))]
    if not xs or not ys:
        sys.exit("no mark found in the source logo")
    x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1
    bw, bh = x1 - x0, y1 - y0

    side = int(max(bw, bh) / (1 - 2 * MARGIN))
    ox, oy = (side - bw) // 2, (side - bh) // 2
    canvas = [bytearray(side * 4) for _ in range(side)]
    for y in range(bh):
        canvas[oy + y][ox * 4:(ox + bw) * 4] = rows[y0 + y][x0 * 4:x1 * 4]

    # Bilinear, premultiplied by alpha so the mark's dark outline doesn't bleed into the
    # transparent surround as a grey halo.
    scale = (side - 1) / (SIZE - 1)
    out = []
    for j in range(SIZE):
        sy = j * scale
        yi = int(sy); fy = sy - yi
        r0, r1 = canvas[yi], canvas[min(yi + 1, side - 1)]
        row = bytearray()
        for i in range(SIZE):
            sx = i * scale
            xi = int(sx); fx = sx - xi
            x2 = min(xi + 1, side - 1)
            acc = [0.0, 0.0, 0.0, 0.0]
            for rr, wy in ((r0, 1 - fy), (r1, fy)):
                if wy == 0: continue
                for xx, wx in ((xi, 1 - fx), (x2, fx)):
                    if wx == 0: continue
                    o = xx * 4
                    a = rr[o + 3] / 255.0
                    k = wy * wx
                    acc[0] += rr[o] * a * k
                    acc[1] += rr[o + 1] * a * k
                    acc[2] += rr[o + 2] * a * k
                    acc[3] += rr[o + 3] * k
            if acc[3] < 0.5:
                row += b"\x00\x00\x00\x00"
            else:
                k = 255.0 / acc[3]
                row += bytes((min(255, int(acc[0] * k + 0.5)),
                              min(255, int(acc[1] * k + 0.5)),
                              min(255, int(acc[2] * k + 0.5)),
                              min(255, int(acc[3] + 0.5))))
        out.append(bytes(row))

    write_png(OUT, SIZE, out)
    print(f"mark {bw}x{bh} -> {os.path.normpath(OUT)} ({SIZE}x{SIZE}, {os.path.getsize(OUT)} bytes)")


main()
