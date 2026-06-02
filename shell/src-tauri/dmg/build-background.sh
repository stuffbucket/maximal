#!/usr/bin/env bash
# Regenerate the DMG background raster from background.svg.
#
# Produces a HiDPI TIFF (1x + 2x representations) so the Finder window
# background is crisp on Retina. Run on macOS after editing the SVG;
# commit the resulting background.tiff (installers.yml copies it into the
# DMG's hidden .background folder).
#
# Requires: rsvg-convert (brew install librsvg) + tiffutil (macOS builtin).
set -euo pipefail
cd "$(dirname "$0")"

rsvg-convert -w 660 -h 420 background.svg -o background-1x.png
rsvg-convert -w 1320 -h 840 background.svg -o background-2x.png
tiffutil -cathidpicheck background-1x.png background-2x.png -out background.tiff
rm -f background-1x.png background-2x.png
echo "Wrote $(pwd)/background.tiff"
