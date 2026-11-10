#!/usr/bin/env bash
# Сборка tide на Mac одной командой: bash build-mac.sh
# Первый раз ставит Rust и Node (если их нет) и собирает около 10 минут; дальше быстрее.
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf "\033[36m➜ %s\033[0m\n" "$*"; }

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Нужны инструменты разработчика Apple: запустите  xcode-select --install  и потом этот скрипт снова."; exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  say "Ставлю Rust (один раз)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi
if ! command -v node >/dev/null 2>&1; then
  say "Ставлю Node.js в папку проекта (один раз)…"
  NV="v22.11.0"; ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
  mkdir -p .tools
  curl -fsSL "https://nodejs.org/dist/$NV/node-$NV-darwin-$ARCH.tar.gz" | tar -xz -C .tools
  export PATH="$PWD/.tools/node-$NV-darwin-$ARCH/bin:$PATH"
fi

TARGET="$(rustc -vV | sed -n 's/^host: //p')"
[ -f "src-tauri/binaries/sing-box-$TARGET" ] || bash scripts/get-singbox.sh "$TARGET"
say "Устанавливаю зависимости…"
npm install --no-audit --no-fund
say "Собираю приложение (первый раз до 10 минут)…"
npx tauri build

APP="src-tauri/target/release/bundle/macos/tide.app"
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
osascript -e 'quit app "tide"' >/dev/null 2>&1 || true
sleep 1
rm -rf /Applications/tide.app
cp -R "$APP" /Applications/
open /Applications/tide.app
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
echo
printf "\033[32m✔ Готово! tide установлен в «Программы» и запущен.\033[0m\n"
[ -n "$DMG" ] && echo "  Установщик для других маков: $DMG"
