# Comic Reader

App Android đọc truyện tranh 18+ từ comics.8muses.com, chạy WebView + proxy server tích hợp.

## Kiến trúc

- **1 Activity** (`MainActivity.java`) — WebView + HTTP proxy nhỏ
- **Frontend** (`web/`) — SPA vanilla JS, hash routing, responsive
- **Build** (`build.sh`) — Script bash, không Gradle (dùng aapt2 + d8 + apksigner)

## Cách hoạt động

Source site không trả CORS → app chạy một HTTP server nhỏ ngay trong app để forward request:

| Endpoint | Chức năng |
|----------|-----------|
| `/api/page?u=...` | Tải HTML (cache 6h, đọc offline) |
| `/img?u=...` | Trả ảnh, tự lưu bộ nhớ đệm |
| `/api/save?u=...&k=...` | Tải trước ảnh (nút "Tải cả bộ") |
| `/api/cache` | Thống kê dung lượng |
| `/api/delete?album=...` | Xoá ảnh theo album |
| `/api/clear` | Xoá toàn bộ ảnh đã lưu |

Ảnh được lưu ở `files/comics/fm/<albumId>/<trang>.jpg`.

## Build

```bash
# Cần: python3, openjdk-17+, aapt2, d8, apksigner, keytool, zip
# và android.jar API 34

VERSION_CODE=1 VERSION_NAME=1.0.0 bash build.sh
```

Kết quả: `out/comic-reader.apk`

## Public API

- `tools/make-icons.py` — Sinh icon bằng Python thuần (không cần Pillow)
- `tools/align_apk.py` — Căn chỉnh APK (thay zipalign)
- `sync-web.py` — Gộp web/index.html + app.css + app.js thành app.html

## Yêu cầu

- Android 7.0+ (API 24)
- Kết nối Internet (cho lần đầu tải)
