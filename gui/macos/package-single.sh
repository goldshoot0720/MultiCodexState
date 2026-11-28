#!/bin/bash
# Build the single-file Apple Silicon GUI for release.
#
# Two artifacts come out of the same publish:
#
#   MultiCodexState       the bare single-file executable
#   MultiCodexState.app   that same binary inside a minimal bundle
#
# macOS runs a bare Mach-O through Terminal: double-clicking it opens a
# Terminal window and leaves it sitting behind the app. Only a bundle is
# started by LaunchServices as a GUI app, with the Dock icon and menu-bar name
# and no Terminal at all - so the zip ships the .app. The bare file stays next
# to it for anyone who wants to launch the GUI from a shell or copy one file.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:?Usage: package-single.sh <output-directory>}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"

dotnet publish "$repo/gui/MultiCodexStateGui/MultiCodexStateGui.csproj" \
    -c Release -r osx-arm64 --self-contained true -o "$work/publish" \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
    -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false

mkdir "$work/payload"
mv "$work/publish/MultiCodexStateGui" "$work/payload/MultiCodexState"
/usr/bin/swift - "$repo/gui/MultiCodexStateGui/Assets/app-icon.png" "$work/payload/MultiCodexState" <<'SWIFT'
import AppKit
guard let icon = NSImage(contentsOfFile: CommandLine.arguments[1]),
      NSWorkspace.shared.setIcon(icon, forFile: CommandLine.arguments[2], options: []) else { exit(1) }
SWIFT

# --- the bundle ------------------------------------------------------------
#
# Contents/MacOS keeps the executable name Info.plist declares, so this reuses
# gui/macos/Info.plist unchanged. The icon is a real .icns instead of the
# Finder resource fork above: a bundle reads CFBundleIconFile, not a fork.
app="$work/payload/MultiCodexState.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$work/payload/MultiCodexState" "$app/Contents/MacOS/MultiCodexStateGui"
chmod +x "$app/Contents/MacOS/MultiCodexStateGui"
cp "$repo/gui/macos/Info.plist" "$app/Contents/Info.plist"

iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
src="$repo/gui/MultiCodexStateGui/Assets/app-icon.png"
for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$src" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$src" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$src" "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

# --- ship ------------------------------------------------------------------

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$work/release.zip"
rm -rf "$output/MultiCodexState.app"
/usr/bin/ditto "$app" "$output/MultiCodexState.app"
/usr/bin/ditto "$work/payload/MultiCodexState" "$output/MultiCodexState"
mv "$work/release.zip" "$output/MultiCodexState-v$version-macos-arm64.zip"

echo "MultiCodexState $version"
echo "  $output/MultiCodexState.app   (double-click, no Terminal)"
echo "  $output/MultiCodexState       (bare binary, opens Terminal)"
echo "  $output/MultiCodexState-v$version-macos-arm64.zip"
