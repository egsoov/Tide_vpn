#!/usr/bin/env bash
# Скачивает ядро sing-box для нужной платформы в src-tauri/binaries/.
# Использование: bash scripts/get-singbox.sh <rust-target>, например aarch64-apple-darwin
set -euo pipefail
VER="1.11.4"
TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
cd "$(dirname "$0")/.."
case "$TARGET" in
  aarch64-apple-darwin)      ARCH="darwin-arm64";  EXT="tar.gz"; BIN="sing-box" ;;
  x86_64-apple-darwin)       ARCH="darwin-amd64";  EXT="tar.gz"; BIN="sing-box" ;;
  x86_64-pc-windows-msvc)    ARCH="windows-amd64"; EXT="zip";    BIN="sing-box.exe" ;;
  aarch64-pc-windows-msvc)   ARCH="windows-arm64"; EXT="zip";    BIN="sing-box.exe" ;;
  *) echo "Неизвестная платформа: $TARGET"; exit 1 ;;
esac
NAME="sing-box-${VER}-${ARCH}"
URL="https://github.com/SagerNet/sing-box/releases/download/v${VER}/${NAME}.${EXT}"
TMP="$(mktemp -d)"
echo "Скачиваю ядро sing-box ${VER} (${ARCH})…"
curl -fsSL -o "$TMP/core.$EXT" "$URL"
if [ "$EXT" = "zip" ]; then
  if command -v unzip >/dev/null 2>&1; then unzip -q "$TMP/core.zip" -d "$TMP"
  else powershell -NoProfile -Command "Expand-Archive -Path '$(cygpath -w "$TMP/core.zip" 2>/dev/null || echo "$TMP/core.zip")' -DestinationPath '$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")'"; fi
else
  tar -xzf "$TMP/core.tar.gz" -C "$TMP"
fi
mkdir -p src-tauri/binaries
OUT="src-tauri/binaries/sing-box-${TARGET}"
[ "$BIN" = "sing-box.exe" ] && OUT="${OUT}.exe"
cp "$TMP/$NAME/$BIN" "$OUT"
chmod +x "$OUT"
if [[ "$TARGET" == *apple-darwin ]]; then codesign --force -s - "$OUT" >/dev/null 2>&1 || true; fi
cp "$TMP/$NAME/LICENSE" src-tauri/binaries/SING-BOX-LICENSE 2>/dev/null || true
rm -rf "$TMP"
echo "Ядро: $OUT"
