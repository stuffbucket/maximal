#!/usr/bin/env python3
# Outline the "maximal" wordmark from the Fraunces variable font to a
# font-independent SVG (so the splash always shows the brand wordmark
# without depending on the font being loaded at boot). Mirrors the H1
# display role at opsz 16, heavy weight, wonky terminals.
#
#   python3 shell/tools/gen-wordmark.py "/path/to/Fraunces[...].ttf" > shell/maximal-wordmark.svg
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

font = TTFont(sys.argv[1])
instantiateVariableFont(font, {"opsz": 16, "wght": 900, "SOFT": 0, "WONK": 1}, inplace=True)
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
pos, x = [], 0
for ch in "maximal":
    g = cmap[ord(ch)]; pos.append((g, x)); x += hmtx[g][0]
b = None
def upd(v):
    global b
    if v: b = list(v) if b is None else [min(b[0],v[0]),min(b[1],v[1]),max(b[2],v[2]),max(b[3],v[3])]
for g, xo in pos:
    bp = BoundsPen(gs); gs[g].draw(TransformPen(bp,(1,0,0,1,xo,0))); upd(bp.bounds)
xMin,yMin,xMax,yMax = b; W,H = xMax-xMin, yMax-yMin
parts=[]
for g,xo in pos:
    sp=SVGPathPen(gs); gs[g].draw(TransformPen(sp,(1,0,0,1,xo,0))); parts.append(sp.getCommands())
print(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" fill="currentColor" aria-label="maximal"><g transform="translate({-xMin:.1f} {yMax:.1f}) scale(1 -1)"><path d="{" ".join(parts)}"/></g></svg>')
