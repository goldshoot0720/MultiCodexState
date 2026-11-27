#!/bin/bash
# Build the Avalonia GUI and open it as a macOS app, so the Dock and the
# menu bar use MultiCodexState rather than "Avalonia Application".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUI="$ROOT/gui/MultiCodexStateGui"
APP="$ROOT/gui/MultiCodexState.app"
PUBLISH="$(mktemp -d)"

# Self-contained so the bundle executable is the app itself. A framework-dependent
# host cannot see Homebrew's .NET when Launch Services starts it, and the Dock
# would show "dotnet" instead of this bundle's name and icon.
dotnet publish "$GUI/MultiCodexStateGui.csproj" -c Release -r osx-arm64 --self-contained true -o "$PUBLISH" -v minimal

ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC="$GUI/Assets/app-icon.png"
sips -z 16 16     "$SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64     "$SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
cp "$SRC" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$PUBLISH/AppIcon.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$PUBLISH"/. "$APP/Contents/MacOS/"
mv "$APP/Contents/MacOS/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/gui/macos/Info.plist" "$APP/Contents/Info.plist"
chmod +x "$APP/Contents/MacOS/MultiCodexStateGui"

open "$APP"
