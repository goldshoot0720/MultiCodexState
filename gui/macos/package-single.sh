#!/bin/bash
# Build the single-file Apple Silicon GUI and preserve its Finder icon in the zip.
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
/usr/bin/ditto -c -k --sequesterRsrc "$work/payload" "$work/release.zip"
/usr/bin/ditto "$work/payload/MultiCodexState" "$output/MultiCodexState"
mv "$work/release.zip" "$output/MultiCodexState-v$version-macos-arm64.zip"
