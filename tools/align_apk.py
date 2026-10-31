#!/usr/bin/env python3
"""Căn chỉnh APK (thay cho zipalign — Termux không có gói này).

    python3 tools/align_apk.py in.apk out.apk [--align 4] [--check]

Android 11+ bắt buộc resources.arsc phải nằm ở dạng không nén và bắt đầu tại
địa chỉ chia hết cho 4. aapt2 không tự căn chỉnh, zipalign thì không có trong
Termux, nên ở đây chép lại file zip và chèn padding vào extra field của header
cho đúng vị trí — y như zipalign làm.
"""

from __future__ import annotations

import argparse
import struct
import sys

LOCAL = 0x04034B50
CENTRAL = 0x02014B50
EOCD = 0x06054B50


def die(msg: str) -> "None":
    print(f"Lỗi: {msg}", file=sys.stderr)
    raise SystemExit(1)


def read_entries(data: bytes) -> tuple[list[dict], int]:
    entries = []
    pos = 0
    while pos + 4 <= len(data):
        sig = struct.unpack_from("<I", data, pos)[0]
        if sig == CENTRAL:
            break
        if sig != LOCAL:
            die(f"header lạ ở offset {pos}")
        (ver, flags, method, mtime, mdate, crc, csize, usize,
         nlen, elen) = struct.unpack_from("<HHHHHIIIHH", data, pos + 4)
        if flags & 0x08:
            die("entry dùng data descriptor — không hỗ trợ")
        name = data[pos + 30:pos + 30 + nlen]
        extra = data[pos + 30 + nlen:pos + 30 + nlen + elen]
        start = pos + 30 + nlen + elen
        entries.append({
            "ver": ver, "flags": flags & ~0x08, "method": method,
            "mtime": mtime, "mdate": mdate, "crc": crc,
            "csize": csize, "usize": usize, "name": name,
            "extra": extra, "data": data[start:start + csize],
        })
        pos = start + csize
    if not entries:
        die("không đọc được entry nào")
    return entries, pos


def pad_extra(extra: bytes, offset: int, name_len: int, align: int) -> bytes:
    """Trả về extra field đã đệm để dữ liệu bắt đầu ở bội số của align."""
    fixed = offset + 30 + name_len + len(extra)
    need = (-fixed) % align
    if need == 0:
        return extra
    if need < 4:
        need += align
    block = struct.pack("<HH", 0x0000, need - 4) + b"\x00" * (need - 4)
    return extra + block


def build(entries: list[dict], align: int) -> bytes:
    out = bytearray()
    central = bytearray()
    for e in entries:
        offset = len(out)
        extra = e["extra"]
        if e["method"] == 0:  # chỉ entry không nén mới cần căn chỉnh
            extra = pad_extra(extra, offset, len(e["name"]), align)
        out += struct.pack(
            "<IHHHHHIIIHH", LOCAL, e["ver"], e["flags"], e["method"],
            e["mtime"], e["mdate"], e["crc"], e["csize"], e["usize"],
            len(e["name"]), len(extra))
        out += e["name"] + extra + e["data"]

        central += struct.pack(
            "<IHHHHHHIIIHHHHHII", CENTRAL, 20, e["ver"], e["flags"],
            e["method"], e["mtime"], e["mdate"], e["crc"], e["csize"],
            e["usize"], len(e["name"]), len(extra), 0, 0, 0, 0, offset)
        central += e["name"] + extra

    cd_offset = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", EOCD, 0, 0, len(entries), len(entries),
                       len(central), cd_offset, 0)
    return bytes(out)


def check(path: str, align: int) -> int:
    data = open(path, "rb").read()
    eocd = data.rfind(struct.pack("<I", EOCD))
    if eocd < 0:
        die("không thấy EOCD")
    count, cd_size, cd_offset = struct.unpack_from("<HII", data, eocd + 10)
    bad = []
    arsc = False
    pos = cd_offset
    for _ in range(count):
        sig, ver_made, ver_need, flags, method, mtime, mdate, crc, csize, usize, \
            nlen, elen, clen, disk, iattr, eattr, offset = struct.unpack_from(
                "<IHHHHHHIIIHHHHHII", data, pos)
        if sig != CENTRAL:
            die(f"central header lạ ở {pos}")
        name = data[pos + 46:pos + 46 + nlen].decode("utf-8", "replace")
        l_nlen, l_elen = struct.unpack_from("<HH", data, offset + 26)
        start = offset + 30 + l_nlen + l_elen
        if method == 0 and start % align:
            bad.append((name, start % align))
        if name == "resources.arsc":
            arsc = True
            if method != 0:
                bad.append(("resources.arsc bị nén", 0))
        pos += 46 + nlen + elen + clen
    if not arsc:
        die("không có resources.arsc")
    if bad:
        for name, rest in bad:
            print(f"  lệch: {name} (dư {rest})", file=sys.stderr)
        return 1
    print(f"  căn chỉnh {align} byte: OK ({count} entry)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--align", type=int, default=4)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        return check(args.src, args.align)
    if not args.dst:
        die("thiếu file đích")

    data = open(args.src, "rb").read()
    entries, cd_start = read_entries(data)
    if cd_start + 4 > len(data) or struct.unpack_from("<I", data, cd_start)[0] != CENTRAL:
        die("không thấy central directory")

    out = build(entries, args.align)
    with open(args.dst, "wb") as fh:
        fh.write(out)
    print(f"  {args.src} → {args.dst} ({len(out) / 1024:.0f} KB)")
    return check(args.dst, args.align)


if __name__ == "__main__":
    sys.exit(main())
