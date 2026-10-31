#!/data/data/com.termux/files/usr/bin/bash
# Build APK ngay trên máy (Termux), không Gradle, không GitHub Actions.
#
#   VERSION_CODE=1 VERSION_NAME=1.0.0 bash build.sh
#
# Cần: python3, openjdk-17+, aapt2, d8, apksigner, keytool, zip
#      và android.jar của API 34 (mặc định $HOME/android/android-34.jar).
#
# Kết quả: out/comic-reader.apk
set -euo pipefail
cd "$(dirname "$0")"

KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0.0}"
PACKAGE="net.comic8muses.reader"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -n "$SDK" ]; then
  export PATH="$SDK/build-tools/34.0.0:$SDK/platform-tools:$SDK/cmdline-tools/latest/bin:$PATH"
fi
if [ -z "${ANDROID_JAR:-}" ]; then
  if [ -n "$SDK" ] && [ -f "$SDK/platforms/android-34/android.jar" ]; then
    ANDROID_JAR="$SDK/platforms/android-34/android.jar"
  else
    ANDROID_JAR="$HOME/android/android-34.jar"
  fi
fi

OUT="out/comic-reader.apk"
GEN="build"

for tool in python3 javac d8 aapt2 apksigner keytool zip; do
  command -v "$tool" >/dev/null || { echo "Thiếu $tool — chạy: pkg install -y openjdk-17 aapt2 d8 apksigner zip"; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "Thiếu $ANDROID_JAR — xem README"; exit 1; }

echo "==> 1/6 gộp giao diện"
python3 sync-web.py

echo "==> 2/6 dọn thư mục build"
rm -rf "$GEN/flat" "$GEN/classes" "$GEN/dex" "$GEN/gen"
mkdir -p "$GEN/flat" "$GEN/classes" "$GEN/dex" "$GEN/gen" out

echo "==> 3/6 biên dịch tài nguyên"
aapt2 compile --dir app/src/main/res -o "$GEN/flat"

echo "==> 4/6 đóng gói APK (chưa có code)"
sed "s|<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">|<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\" package=\"$PACKAGE\">|" \
  app/src/main/AndroidManifest.xml > "$GEN/AndroidManifest.xml"
grep -q "package=\"$PACKAGE\"" "$GEN/AndroidManifest.xml" || { echo "Không chèn được package vào manifest"; exit 1; }

# shellcheck disable=SC2046
aapt2 link \
  -o "$GEN/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$GEN/AndroidManifest.xml" \
  --java "$GEN/gen" \
  -A app/src/main/assets \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  "$GEN"/flat/*.flat

echo "==> 5/6 biên dịch Java + dex"
# shellcheck disable=SC2046
javac -nowarn -Xlint:-options --release 11 -classpath "$ANDROID_JAR" \
  -d "$GEN/classes" $(find app/src/main/java "$GEN/gen" -name '*.java')

# shellcheck disable=SC2046
d8 --release --min-api 24 --lib "$ANDROID_JAR" --output "$GEN/dex" \
  $(find "$GEN/classes" -name '*.class')

( cd "$GEN/dex" && touch -t 198001010000 classes.dex && zip -q -j ../base.apk classes.dex )

echo "==> 6/6 căn chỉnh + ký APK"
python3 tools/align_apk.py "$GEN/base.apk" "$GEN/aligned.apk" --align 4
mkdir -p "$(dirname "$KEYSTORE")"
if [ ! -f "$KEYSTORE" ]; then
  echo "    tạo debug keystore: $KEYSTORE"
  keytool -genkeypair -noprompt \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -alias androiddebugkey -storepass android -keypass android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

rm -f "$OUT"
apksigner sign \
  --ks "$KEYSTORE" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT" "$GEN/aligned.apk"
apksigner verify --print-certs "$OUT" | head -4
python3 tools/align_apk.py "$OUT" --check --align 4

ls -lh "$OUT"
echo "Xong: $OUT"
