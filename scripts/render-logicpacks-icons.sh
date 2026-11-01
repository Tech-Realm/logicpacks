#!/usr/bin/env bash
# Renders every LogicPacks icon from the one source mark (assets/brand/logicpacks-mark.svg).
# Needs rsvg-convert and ImageMagick (`brew install librsvg imagemagick`); iconutil on macOS for the .icns.
#
#   scripts/render-logicpacks-icons.sh
#
# Writes the web icons (favicon.ico 16/32/48, 16 and 32 PNGs, apple-touch 180, manifest 192/512 and
# a maskable 512) to assets/<channel>/ and apps/web/public/, and the desktop icons (macOS 1024 with
# the pre-Tahoe safe area, .icns, iOS 1024, Linux 1024, Windows .ico). All channels share one mark.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mark="$root/assets/brand/logicpacks-mark.svg"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/lp-icons.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

INK="#181818"
PAPER="#ececea"

# The glyph's inner geometry on the 32-unit grid, wrapped into a canvas of `size` with the glyph
# occupying `glyph` units of it, on an optional tile.
#   tile_svg <size> <tile-inset> <tile-radius> <glyph-scale> [shadow]
tile_svg() {
  local size=$1 inset=$2 radius=$3 scale=$4 shadow=${5:-}
  local body=$((size - 2 * inset))
  local glyph
  glyph=$(awk -v b="$body" -v s="$scale" 'BEGIN { printf "%.4f", b * s / 32 }')
  local offset
  offset=$(awk -v b="$body" -v s="$scale" -v i="$inset" 'BEGIN { printf "%.4f", i + (b - b * s) / 2 }')
  local filter="" filterRef=""
  if [ -n "$shadow" ]; then
    filter="<defs><filter id=\"s\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\"><feGaussianBlur in=\"SourceAlpha\" stdDeviation=\"$((size / 80))\"/><feOffset dy=\"$((size / 100))\"/><feComponentTransfer><feFuncA type=\"linear\" slope=\"0.45\"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter></defs>"
    filterRef=" filter=\"url(#s)\""
  fi
  cat <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="$size" height="$size" viewBox="0 0 $size $size">
  $filter
  <rect x="$inset" y="$inset" width="$body" height="$body" rx="$radius" fill="$INK"$filterRef/>
  <g transform="translate($offset $offset) scale($glyph)">
    $(sed -n '/<rect/,/<circle/p' "$mark")
  </g>
</svg>
EOF
}

render() { # <svg-file> <size> <out.png>
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

# Favicon tile: the logicpacks.io favicon (rounded tile, full glyph).
tile_svg 512 0 112 1 >"$tmp/favicon.svg"
# Opaque square for platforms that apply their own mask (apple-touch, iOS, maskable).
tile_svg 1024 0 0 1 >"$tmp/square.svg"
# Maskable: glyph inside the 80% safe zone.
tile_svg 1024 0 0 0.8 >"$tmp/maskable.svg"
# macOS pre-Tahoe: 824 body inset 100, continuous-corner radius, soft drop shadow.
tile_svg 1024 100 185 1 shadow >"$tmp/macos.svg"
# Linux and Windows: rounded tile with a little breathing room.
tile_svg 1024 64 200 1 >"$tmp/universal.svg"

for size in 16 32 48 64 128 180 192 256 512; do
  render "$tmp/favicon.svg" "$size" "$tmp/favicon-$size.png"
done
render "$tmp/square.svg" 180 "$tmp/apple-touch-180.png"
render "$tmp/square.svg" 1024 "$tmp/ios-1024.png"
render "$tmp/maskable.svg" 512 "$tmp/maskable-512.png"
render "$tmp/macos.svg" 1024 "$tmp/macos-1024.png"
render "$tmp/universal.svg" 1024 "$tmp/universal-1024.png"
for size in 16 24 32 48 64 128 256; do
  render "$tmp/universal.svg" "$size" "$tmp/universal-$size.png"
done

magick "$tmp/favicon-16.png" "$tmp/favicon-32.png" "$tmp/favicon-48.png" "$tmp/favicon.ico"
magick "$tmp"/universal-{16,24,32,48,64,128,256}.png "$tmp/windows.ico"

if command -v iconutil >/dev/null; then
  iconset="$tmp/logicpacks.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    render "$tmp/macos.svg" "$size" "$iconset/icon_${size}x${size}.png"
    render "$tmp/macos.svg" "$((size * 2))" "$iconset/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$iconset" -o "$root/assets/prod/logicpacks-macos.icns"
fi

web_into() { # <dir> <prefix>
  cp "$tmp/favicon.ico" "$1/${2}favicon.ico"
  cp "$tmp/favicon-16.png" "$1/${2}favicon-16x16.png"
  cp "$tmp/favicon-32.png" "$1/${2}favicon-32x32.png"
  cp "$tmp/apple-touch-180.png" "$1/${2}apple-touch-180.png"
}

# Production (the paths scripts/lib/brand-assets.ts points at).
prod="$root/assets/prod"
web_into "$prod" "logicpacks-web-"
cp "$tmp/macos-1024.png" "$prod/logicpacks-macos-1024.png"
cp "$tmp/ios-1024.png" "$prod/logicpacks-ios-1024.png"
cp "$tmp/universal-1024.png" "$prod/logicpacks-universal-1024.png"
cp "$tmp/windows.ico" "$prod/logicpacks-windows.ico"

# Development and nightly builds wear the same mark.
dev="$root/assets/dev"
web_into "$dev" "blueprint-web-"
cp "$tmp/macos-1024.png" "$dev/blueprint-macos-1024.png"
cp "$tmp/ios-1024.png" "$dev/blueprint-ios-1024.png"
cp "$tmp/universal-1024.png" "$dev/blueprint-universal-1024.png"
cp "$tmp/windows.ico" "$dev/blueprint-windows.ico"
nightly="$root/assets/nightly"
web_into "$nightly" "nightly-web-"
cp "$tmp/macos-1024.png" "$nightly/nightly-macos-1024.png"
cp "$tmp/ios-1024.png" "$nightly/nightly-ios-1024.png"
cp "$tmp/universal-1024.png" "$nightly/nightly-universal-1024.png"
cp "$tmp/windows.ico" "$nightly/nightly-windows.ico"

# The web app's public folder (dev server, boot shell, manifest).
public="$root/apps/web/public"
cp "$tmp/favicon.ico" "$public/favicon.ico"
cp "$tmp/favicon-16.png" "$public/favicon-16x16.png"
cp "$tmp/favicon-32.png" "$public/favicon-32x32.png"
cp "$tmp/apple-touch-180.png" "$public/apple-touch-icon.png"
cp "$tmp/favicon-192.png" "$public/icon-192.png"
cp "$tmp/favicon-512.png" "$public/icon-512.png"
cp "$tmp/maskable-512.png" "$public/icon-maskable-512.png"
cp "$root/assets/brand/logicpacks-icon.svg" "$public/favicon.svg"

echo "Rendered LogicPacks icons from $mark"
