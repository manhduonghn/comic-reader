#!/usr/bin/env python3
"""Sinh icon cho Comic 8muses bằng Python thuần (không cần Pillow).

Vẽ ở 4x rồi thu nhỏ để có khử răng cưa. Icon là một trang truyện tranh màu cam
trên nền tối, chia ô bằng các đường kẻ màu nền.
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
RES = ROOT / "app/src/main/res"

BG = (18, 16, 14, 255)
BG2 = (30, 24, 19, 255)
ACC = (240, 147, 43, 255)
PANEL = (18, 16, 14, 255)
SS = 4


def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    dx = max(x0 + r - x, 0.0, x - (x1 - r))
    dy = max(y0 + r - y, 0.0, y - (y1 - r))
    return dx * dx + dy * dy <= r * r


def circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shade(t):
    """Nền tối, hơi sáng ở góc trên trái."""
    k = max(0.0, min(1.0, 1.0 - t))
    return tuple(
        int(BG[i] + (BG2[i] - BG[i]) * (0.55 * k))
        for i in range(3)
    ) + (255,)


def paint(n, round_bg, art):
    """art(x, y) -> RGBA tại toạ độ chuẩn hoá 0..1; None = trong suốt."""
    px = []
    for j in range(n):
        y = (j + 0.5) / n
        row = []
        for i in range(n):
            x = (i + 0.5) / n
            c = art(x, y, round_bg)
            row.append(c)
        px.append(row)
    return px


def art_full(x, y, round_bg):
    """Icon thường: nền tối kín canvas + trang truyện."""
    if round_bg:
        if not circle(x, y, 0.5, 0.5, 0.5):
            return (0, 0, 0, 0)
    else:
        if not rrect(x, y, 0.0, 0.0, 1.0, 1.0, 0.215):
            return (0, 0, 0, 0)

    d = ((x - 0.30) ** 2 + (y - 0.22) ** 2) ** 0.5
    base = shade(d)

    # trang truyện
    if rrect(x, y, 0.235, 0.165, 0.765, 0.835, 0.045):
        # các ô bên trong
        panels = [
            (0.285, 0.215, 0.495, 0.455),
            (0.515, 0.215, 0.715, 0.455),
            (0.285, 0.500, 0.715, 0.620),
            (0.285, 0.665, 0.440, 0.785),
            (0.465, 0.665, 0.715, 0.785),
        ]
        for x0, y0, x1, y1 in panels:
            if rrect(x, y, x0, y0, x1, y1, 0.012):
                return PANEL
        return ACC
    return base


def art_fg(x, y, _round_bg):
    """Foreground cho adaptive icon: trong suốt, nội dung nằm trong vùng an toàn."""
    # Trang truyện nằm gọn trong vùng an toàn 66% ở giữa canvas 108dp.
    if not rrect(x, y, 0.28, 0.17, 0.72, 0.83, 0.045):
        return (0, 0, 0, 0)

    inner = [
        (0.320, 0.220, 0.485, 0.440),
        (0.515, 0.220, 0.680, 0.440),
        (0.320, 0.475, 0.680, 0.575),
        (0.320, 0.610, 0.445, 0.780),
        (0.475, 0.610, 0.680, 0.780),
    ]
    for x0, y0, x1, y1 in inner:
        if rrect(x, y, x0, y0, x1, y1, 0.012):
            return PANEL
    return ACC


def downsample(px, factor):
    n = len(px)
    out = []
    for j in range(0, n, factor):
        row = []
        for i in range(0, n, factor):
            sa = sr = sg = sb = 0
            for y in range(j, j + factor):
                for x in range(i, i + factor):
                    r, g, b, a = px[y][x]
                    sa += a
                    sr += r * a
                    sg += g * a
                    sb += b * a
            if sa == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((sr // sa, sg // sa, sb // sa, sa // (factor * factor)))
        out.append(row)
    return out


def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = bytearray()
    for row in px:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main():
    for size, folder in [
        (48, "mipmap-mdpi"), (72, "mipmap-hdpi"), (96, "mipmap-xhdpi"),
        (144, "mipmap-xxhdpi"), (192, "mipmap-xxxhdpi"),
    ]:
        for name, round_bg in [("ic_launcher.png", False), ("ic_launcher_round.png", True)]:
            n = size * SS
            px = paint(n, round_bg, art_full)
            write_png(RES / folder / name, downsample(px, SS))
        print(f"  {folder}: {size}px")

    n = 432 * SS
    px = paint(n, False, art_fg)
    write_png(RES / "drawable-nodpi/ic_launcher_foreground.png", downsample(px, SS))
    print("  foreground: 432px")


if __name__ == "__main__":
    main()
