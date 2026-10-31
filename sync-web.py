#!/usr/bin/env python3
"""Gộp web/index.html + app.css + app.js thành một app.html duy nhất.

WebView nạp app.html bằng loadDataWithBaseURL(), nên tài nguyên tương đối
không được phục vụ. Nhúng thẳng CSS/JS vào file để app chỉ cần một tài sản.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
WEB = ROOT / "web"
OUT = ROOT / "app/src/main/assets/web/app.html"


def main() -> int:
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "app.css").read_text(encoding="utf-8")
    js = (WEB / "app.js").read_text(encoding="utf-8")

    if "</script" in js.lower():
        print("app.js chứa </script> — không nhúng được", file=sys.stderr)
        return 1

    html = html.replace(
        '<link rel="stylesheet" href="app.css">',
        "<style>\n" + css + "\n</style>",
    )
    html = html.replace(
        '<script src="app.js"></script>',
        "<script>\n" + js + "\n</script>",
    )
    if "app.css" in html or 'src="app.js"' in html:
        print("Không thay được thẻ CSS/JS trong index.html", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    size = OUT.stat().st_size
    print(f"  app.html: {size / 1024:.1f} KB (gộp CSS + JS)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
