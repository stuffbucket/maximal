// Maximal Agent (dev) — FigJam side.
//
// Runs in Figma's plugin sandbox. The panel (ui.html) runs the agent loop and
// asks this file to run one tool at a time; each tool call is one undo step.
// Every tool's schema lives next to its implementation (see `tool(...)`) and
// is sent to the panel on init, so the panel's agent and the bridge use the
// same list.
//
// Written without optional chaining, nullish coalescing, object spread or
// arrow functions to stay within what the plugin sandbox is known to accept.

// Bump the patch for every change (see README → Versions).
var PLUGIN_VERSION = "0.10.0"
var LOADED_AT = new Date().toISOString()
var SETTINGS_KEY = "maximal-agent-settings"
var loadedSettings = {}
var settingsLoadProblem

function clamp(value, min, max, fallback) {
  var number = Number(value)
  if (!isFinite(number)) number = fallback
  return Math.min(Math.max(number, min), max)
}

async function loadSettings() {
  return (await figma.clientStorage.getAsync(SETTINGS_KEY)) || {}
}

// The instance name ("giddy-otter") identifies this plugin run to the bridge
// and is shown in Figma's window title. Figma only takes the title at
// showUI, so it's chosen here and handed to the panel on its <html> tag.
var MOODS = ["giddy", "calm", "brave", "sleepy", "curious", "jolly", "grumpy", "proud", "shy", "eager",
  "happy", "merry", "bold", "keen", "zany", "witty", "cheery", "plucky", "sunny", "chill",
  "dreamy", "fierce", "gentle", "glad", "hasty", "humble", "jaunty", "kind", "lively", "lucky",
  "mellow", "nimble", "perky", "quiet", "silly", "snappy", "spry", "upbeat", "wise", "zesty"]
var ANIMALS = ["otter", "lynx", "heron", "panda", "gecko", "moose", "koala", "falcon", "badger", "bison",
  "crane", "dingo", "eagle", "ferret", "gibbon", "hare", "ibis", "jackal", "kiwi", "lemur",
  "marten", "newt", "ocelot", "puffin", "quail", "raven", "seal", "tapir", "urchin", "vole",
  "walrus", "yak", "zebra", "beaver", "camel", "dove", "egret", "fox", "goose", "llama"]
function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)]
}
var INSTANCE_NAME = pickOne(MOODS) + "-" + pickOne(ANIMALS)

// Current window size in UI pixels (Figma has no getter for it).
var uiSize = { width: 400, height: 640 }
// Figma's own title bar above the panel, in UI pixels (approximate).
var TITLE_BAR = 40
var SCREEN_MARGIN = 8

function showPlugin(settings) {
  var savedWindow = settings && settings.window ? settings.window : {}
  var compact = savedWindow.mode === "compact"
  var width = compact ? 300 : clamp(savedWindow.width, 320, 1400, 400)
  var height = compact ? 48 : clamp(savedWindow.height, 360, 1200, 640)
  uiSize = { width: width, height: height }
  var html = String(__html__).replace("<html", '<html data-session="' + INSTANCE_NAME + '"')
  figma.showUI(html, { width: width, height: height, themeColors: true, title: "Agent · " + INSTANCE_NAME })
}

// Resize the window. With `anchor`, switching between the bar and the full
// panel grows away from the nearest screen edge: a bar in the bottom half
// keeps its bottom edge and opens upward, one in the right half keeps its
// right edge and opens leftward. The result is then kept inside the visible
// canvas, so it never opens off screen. Collapsing goes back to where the bar
// was, unless the panel was moved while it was open.
var anchorMemory = null // { bar: position before opening, open: position after }

function samePosition(a, b, zoom) {
  return Math.abs(a.x - b.x) <= 2 / zoom && Math.abs(a.y - b.y) <= 2 / zoom
}

function resizeUI(width, height, anchor) {
  var prev = uiSize
  figma.ui.resize(width, height)
  uiSize = { width: width, height: height }
  if (!anchor) return
  try {
    var pos = figma.ui.getPosition().canvasSpace
    var view = figma.viewport.bounds
    var zoom = figma.viewport.zoom
    var growing = width * height > prev.width * prev.height
    if (!growing && anchorMemory && samePosition(pos, anchorMemory.open, zoom)) {
      var bar = anchorMemory.bar
      anchorMemory = null
      if (!samePosition(pos, bar, zoom)) figma.ui.reposition(bar.x, bar.y)
      return
    }
    anchorMemory = null
    var prevW = prev.width / zoom
    var prevH = (prev.height + TITLE_BAR) / zoom
    var nextW = width / zoom
    var nextH = (height + TITLE_BAR) / zoom
    var margin = SCREEN_MARGIN / zoom
    var x = pos.x
    var y = pos.y
    if (y + prevH / 2 > view.y + view.height / 2) y += prevH - nextH
    if (x + prevW / 2 > view.x + view.width / 2) x += prevW - nextW
    // Fit inside the view; if it can't fit, keep the top-left (title bar) visible.
    x = Math.max(Math.min(x, view.x + view.width - nextW - margin), view.x + margin)
    y = Math.max(Math.min(y, view.y + view.height - nextH - margin), view.y + margin)
    if (!samePosition({ x: x, y: y }, pos, zoom)) figma.ui.reposition(x, y)
    if (growing) anchorMemory = { bar: { x: pos.x, y: pos.y }, open: { x: x, y: y } }
  } catch (error) {
    // Position APIs unavailable: the resize above still happened.
  }
}

var startupReady = loadSettings().then(function (settings) {
  loadedSettings = settings
  showPlugin(settings)
}, function (error) {
  settingsLoadProblem = "Couldn't read saved settings: " + String((error && error.message) || error)
  showPlugin({})
})

// ------------------------------------------------------------------ palette

function h(r, g, b) {
  return { r: r / 255, g: g / 255, b: b / 255 }
}

// FigJam palettes (hex/255 so FigJam treats them as palette colors).
var STICKY = {
  white: h(0xff, 0xff, 0xff), gray: h(0xe6, 0xe6, 0xe6), green: h(0xb3, 0xef, 0xbd),
  teal: h(0xb3, 0xf4, 0xef), blue: h(0xa8, 0xda, 0xff), violet: h(0xd3, 0xbd, 0xff),
  pink: h(0xff, 0xa8, 0xdb), red: h(0xff, 0xb8, 0xa8), orange: h(0xff, 0xd3, 0xa8),
  yellow: h(0xff, 0xe2, 0x99),
}
var SECTION = {
  white: h(0xff, 0xff, 0xff), gray: h(0xf9, 0xf9, 0xf9), green: h(0xeb, 0xff, 0xee),
  teal: h(0xf1, 0xfe, 0xfd), blue: h(0xf5, 0xfb, 0xff), violet: h(0xf8, 0xf5, 0xff),
  pink: h(0xff, 0xf0, 0xfa), red: h(0xff, 0xf5, 0xf5), orange: h(0xff, 0xf7, 0xf0),
  yellow: h(0xff, 0xfb, 0xf0),
}
var CONNECTOR = {
  black: h(0x1e, 0x1e, 0x1e), gray: h(0x75, 0x75, 0x75), green: h(0x66, 0xd5, 0x75),
  teal: h(0x5a, 0xd8, 0xcc), blue: h(0x3d, 0xad, 0xff), violet: h(0x87, 0x4f, 0xff),
  pink: h(0xf8, 0x49, 0xc1), red: h(0xff, 0x75, 0x56), orange: h(0xff, 0x9e, 0x42),
  yellow: h(0xff, 0xc9, 0x43),
}
var WHITE = h(0xff, 0xff, 0xff)
var CHARCOAL = h(0x1e, 0x1e, 0x1e)
var SHAPE = {
  black: { fill: h(0x1e, 0x1e, 0x1e), stroke: h(0xb3, 0xb3, 0xb3), text: WHITE },
  green: { fill: h(0x66, 0xd5, 0x75), stroke: h(0x3e, 0x9b, 0x4b), text: WHITE },
  teal: { fill: h(0x5a, 0xd8, 0xcc), stroke: h(0x36, 0x9e, 0x94), text: WHITE },
  blue: { fill: h(0x3d, 0xad, 0xff), stroke: h(0x00, 0x7a, 0xd2), text: WHITE },
  violet: { fill: h(0x87, 0x4f, 0xff), stroke: h(0x54, 0x27, 0xb4), text: WHITE },
  pink: { fill: h(0xf8, 0x49, 0xc1), stroke: h(0xb4, 0x24, 0x87), text: WHITE },
  red: { fill: h(0xff, 0x75, 0x56), stroke: h(0xdc, 0x30, 0x09), text: WHITE },
  orange: { fill: h(0xff, 0x9e, 0x42), stroke: h(0xeb, 0x75, 0x00), text: WHITE },
  gray: { fill: h(0xb3, 0xb3, 0xb3), stroke: h(0x8f, 0x8f, 0x8f), text: CHARCOAL },
  yellow: { fill: h(0xff, 0xc9, 0x43), stroke: h(0xe8, 0xa3, 0x02), text: CHARCOAL },
  white: { fill: h(0xff, 0xff, 0xff), stroke: h(0xb3, 0xb3, 0xb3), text: CHARCOAL },
}
// Labels (numbered circles) use the shape presets plus two grays.
var LABEL = {}
Object.keys(SHAPE).forEach(function (k) { LABEL[k] = SHAPE[k] })
LABEL.darkGray = { fill: h(0x75, 0x75, 0x75), stroke: h(0x5e, 0x5e, 0x5e), text: WHITE }
LABEL.lightGray = { fill: h(0xd9, 0xd9, 0xd9), stroke: h(0xb3, 0xb3, 0xb3), text: CHARCOAL }
// Table and cell fills (FigJam's table palette).
var TABLE = {
  black: { fill: h(0x1e, 0x1e, 0x1e), text: WHITE }, darkGray: { fill: h(0x75, 0x75, 0x75), text: WHITE },
  green: { fill: h(0x66, 0xd5, 0x75), text: WHITE }, teal: { fill: h(0x5a, 0xd8, 0xcc), text: WHITE },
  blue: { fill: h(0x3d, 0xad, 0xff), text: WHITE }, violet: { fill: h(0x87, 0x4f, 0xff), text: WHITE },
  pink: { fill: h(0xf8, 0x49, 0xc1), text: WHITE }, red: { fill: h(0xf2, 0x48, 0x22), text: WHITE },
  orange: { fill: h(0xff, 0x9e, 0x42), text: WHITE },
  gray: { fill: h(0xb3, 0xb3, 0xb3), text: CHARCOAL }, lightGray: { fill: h(0xd9, 0xd9, 0xd9), text: CHARCOAL },
  lightGreen: { fill: h(0xcd, 0xf4, 0xd3), text: CHARCOAL }, lightTeal: { fill: h(0xc6, 0xfa, 0xf6), text: CHARCOAL },
  lightBlue: { fill: h(0xc2, 0xe5, 0xff), text: CHARCOAL }, lightViolet: { fill: h(0xdc, 0xcc, 0xff), text: CHARCOAL },
  lightPink: { fill: h(0xff, 0xc2, 0xec), text: CHARCOAL }, lightRed: { fill: h(0xff, 0xc7, 0xc2), text: CHARCOAL },
  lightOrange: { fill: h(0xff, 0xe0, 0xc2), text: CHARCOAL }, yellow: { fill: h(0xff, 0xc9, 0x43), text: CHARCOAL },
  lightYellow: { fill: h(0xff, 0xec, 0xbd), text: CHARCOAL }, white: { fill: h(0xff, 0xff, 0xff), text: CHARCOAL },
}

// FigJam's 20-swatch toolbar palette (shape fill/stroke and text popovers):
// row 1 saturated, row 2 light tints. "light blue", "lightBlue" and
// "light-blue" are the same name (see normName).
var SWATCH = {
  black: h(0x1e, 0x1e, 0x1e), darkGray: h(0x75, 0x75, 0x75), red: h(0xff, 0x75, 0x56),
  orange: h(0xff, 0x9e, 0x42), yellow: h(0xff, 0xc9, 0x43), green: h(0x66, 0xd5, 0x75),
  teal: h(0x5a, 0xd8, 0xcc), blue: h(0x3d, 0xad, 0xff), violet: h(0x87, 0x4f, 0xff),
  pink: h(0xf8, 0x49, 0xc1), white: h(0xff, 0xff, 0xff),
  lightGray: h(0xd9, 0xd9, 0xd9), lighterGray: h(0xf5, 0xf5, 0xf5), lightRed: h(0xff, 0xc7, 0xc2),
  lightOrange: h(0xff, 0xe0, 0xc2), lightYellow: h(0xff, 0xec, 0xbd), lightGreen: h(0xcd, 0xf4, 0xd3),
  lightTeal: h(0xc6, 0xfa, 0xf6), lightBlue: h(0xc2, 0xe5, 0xff), lightViolet: h(0xdc, 0xcc, 0xff),
  lightPink: h(0xff, 0xc2, 0xec),
}
// convert_node maps colors onto these (pastel tints would win nearest-RGB).
var SHAPE_BASE_KEYS = Object.keys(SHAPE)
// Shape presets for swatches the SHAPE table lacks: dark gray and the tints
// (tint fill, the base hue's stroke, charcoal text).
SHAPE.darkGray = { fill: SWATCH.darkGray, stroke: h(0x5e, 0x5e, 0x5e), text: WHITE }
;["Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Violet", "Pink"].forEach(function (hue) {
  SHAPE["light" + hue] = { fill: SWATCH["light" + hue], stroke: SHAPE[hue.toLowerCase()].stroke, text: CHARCOAL }
})
SHAPE.lightGray = { fill: SWATCH.lightGray, stroke: h(0xb3, 0xb3, 0xb3), text: CHARCOAL }
SHAPE.lighterGray = { fill: SWATCH.lighterGray, stroke: h(0xb3, 0xb3, 0xb3), text: CHARCOAL }
LABEL.lighterGray = SHAPE.lighterGray
Object.keys(SHAPE).forEach(function (k) { if (!LABEL[k]) LABEL[k] = SHAPE[k] })
// FigJam's "Transparent" fill mode: the chosen hue, translucent (approximated).
var TRANSPARENT_OPACITY = 0.25
var DASHED = [10, 6]

function colorName(palette, paints) {
  if (!Array.isArray(paints) || paints.length === 0 || paints[0].type !== "SOLID") return undefined
  var c = paints[0].color
  var names = Object.keys(palette)
  for (var i = 0; i < names.length; i++) {
    var p = palette[names[i]].fill || palette[names[i]]
    if (Math.abs(p.r - c.r) < 0.002 && Math.abs(p.g - c.g) < 0.002 && Math.abs(p.b - c.b) < 0.002) return names[i]
  }
  return "custom"
}

// "Light Blue", "light-blue", "light_blue", "lightBlue" -> "lightblue"; grey -> gray.
function normName(name) {
  return String(name).toLowerCase().replace(/[\s_-]+/g, "").replace(/grey/g, "gray")
}

function findKey(palette, name) {
  var want = normName(name)
  var keys = Object.keys(palette)
  for (var i = 0; i < keys.length; i++) if (normName(keys[i]) === want) return keys[i]
  return undefined
}

// A palette entry by name. Names only in the toolbar's 20 swatches fall back
// to that swatch (as {fill, stroke, text} when the palette holds presets).
function pick(palette, name, fallback) {
  var key = findKey(palette, name || fallback)
  if (key) return palette[key]
  var sw = palette !== SWATCH ? findKey(SWATCH, name || fallback) : undefined
  if (sw) {
    var c = SWATCH[sw]
    var first = palette[Object.keys(palette)[0]]
    if (first && first.r === undefined) return { fill: c, stroke: c, text: luminance(c) > 0.4 ? CHARCOAL : WHITE }
    return c
  }
  throw new Error("Unknown color \"" + name + "\". Use one of: " + Object.keys(palette).join(", ") + "; the toolbar swatches " + Object.keys(SWATCH).join(", ") + "; or a hex value.")
}

function isHex(value) {
  return typeof value === "string" && /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())
}

// "#RGB", "#RRGGBB" or "#RRGGBBAA" → { color, opacity }.
function parseHex(value) {
  var s = value.trim().replace(/^#/, "")
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  var out = { color: h(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)) }
  if (s.length === 8) out.opacity = parseInt(s.slice(6, 8), 16) / 255
  return out
}

// A solid paint from a hex value or a palette name. `part` picks fill/stroke/text
// from presets that carry several colors.
function solid(value, palette, part) {
  if (isHex(value)) {
    var c = parseHex(value)
    var paint = { type: "SOLID", color: c.color }
    if (typeof c.opacity === "number") paint.opacity = c.opacity
    return paint
  }
  if (!palette) palette = SWATCH
  var entry = pick(palette, value)
  return { type: "SOLID", color: entry.r === undefined ? entry[part || "fill"] || entry.fill : entry }
}

function hex(c) {
  function two(v) {
    var s = Math.round(v * 255).toString(16)
    return s.length < 2 ? "0" + s : s
  }
  return "#" + (two(c.r) + two(c.g) + two(c.b)).toUpperCase()
}

function paintsOut(paints) {
  if (paints === figma.mixed) return "mixed"
  if (!Array.isArray(paints)) return undefined
  return paints.map(function (p) {
    var o = { type: p.type }
    if (p.color) o.color = hex(p.color)
    if (typeof p.opacity === "number" && p.opacity !== 1) o.opacity = Math.round(p.opacity * 100) / 100
    if (p.visible === false) o.visible = false
    if (p.imageHash) o.imageHash = p.imageHash
    if (p.scaleMode) o.scaleMode = p.scaleMode
    return o
  })
}

// ------------------------------------------------------------------ helpers

var GAP = 64
var PAD = 48
var MAX_TEXT = 280

function clipText(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s
}

function errorText(error) {
  return String((error && error.message) || error)
}

function round(v) {
  return Math.round(v * 100) / 100
}

// The text-bearing part of a node: the node itself for TEXT, else its text sublayer.
function textTarget(node) {
  if (node.type === "TEXT") return node
  if ("text" in node && node.text && typeof node.text.characters === "string") return node.text
  return undefined
}

function textOf(node) {
  if (node.type === "CODE_BLOCK") return node.code
  var t = textTarget(node)
  return t ? t.characters : undefined
}

function isPageId(id) {
  var pages = figma.root.children
  for (var i = 0; i < pages.length; i++) if (pages[i].id === id) return true
  return false
}

function pageOf(node) {
  var p = node
  while (p && p.type !== "PAGE") p = p.parent
  return p
}

// FigJam reports a free (unattached) connector end with endpointNodeId set to
// the page's id, so a page id, like a missing id, means "floating".
function isFloating(ep) {
  return !ep || !ep.endpointNodeId || isPageId(ep.endpointNodeId)
}

function endpointOut(ep) {
  if (!ep) return undefined
  if (isFloating(ep)) {
    return ep.position ? { point: { x: Math.round(ep.position.x), y: Math.round(ep.position.y) } } : {}
  }
  var o = { nodeId: ep.endpointNodeId }
  if (ep.magnet) o.magnet = ep.magnet
  if (ep.position) o.position = { x: round(ep.position.x), y: round(ep.position.y) }
  return o
}

function linkOf(target) {
  try {
    var link = target.hyperlink
    if (link === figma.mixed) return "mixed"
    return link ? { type: link.type, value: link.value } : undefined
  } catch (error) {
    return undefined
  }
}

function describe(node) {
  var d = {
    id: node.id,
    type: node.type,
    name: node.name,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
  }
  var text = textOf(node)
  if (text !== undefined) d.text = clipText(text)
  if (node.parent && node.parent.type === "SECTION") d.sectionId = node.parent.id
  if (node.parent && node.parent.type === "GROUP") d.groupId = node.parent.id
  if (node.type === "STICKY") d.color = colorName(STICKY, node.fills)
  if (node.type === "SECTION") {
    d.color = colorName(SECTION, node.fills)
    d.childCount = node.children.length
  }
  if (node.type === "GROUP") d.childCount = node.children.length
  if (node.type === "SHAPE_WITH_TEXT") {
    d.shape = node.shapeType
    d.color = colorName(SHAPE, node.fills)
  }
  if (node.type === "CONNECTOR") {
    var s = node.connectorStart
    var e = node.connectorEnd
    if (!isFloating(s)) {
      d.from = s.endpointNodeId
      d.startMagnet = s.magnet
    } else if (s && s.position) d.fromPoint = { x: Math.round(s.position.x), y: Math.round(s.position.y) }
    if (!isFloating(e)) {
      d.to = e.endpointNodeId
      d.endMagnet = e.magnet
    } else if (e && e.position) d.toPoint = { x: Math.round(e.position.x), y: Math.round(e.position.y) }
    d.lineType = node.connectorLineType
  }
  if (node.type === "TABLE") {
    d.rows = node.numRows
    d.columns = node.numColumns
  }
  if (node.type === "CODE_BLOCK") d.language = node.codeLanguage
  if (node.type === "LINK_UNFURL" && node.linkUnfurlData) d.url = node.linkUnfurlData.url
  if (node.type === "EMBED" && node.embedData) d.url = node.embedData.srcUrl
  var t = textTarget(node)
  if (t && text) {
    var link = linkOf(t)
    if (link) d.link = link
  }
  if (node.locked) d.locked = true
  d.rev = rev(node)
  return d
}

// Everything worth knowing about one node, for get_node.
function detail(node, depth) {
  var d = describe(node)
  var full = textOf(node)
  if (typeof full === "string" && full.length > MAX_TEXT) d.text = full.length > 20000 ? full.slice(0, 20000) + "…" : full
  var b = node.absoluteBoundingBox
  if (b) d.absolute = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
  if (node.parent) d.parent = { id: node.parent.id, type: node.parent.type, name: node.parent.name }
  var page = pageOf(node)
  if (page) d.page = { id: page.id, name: page.name }
  if ("rotation" in node && node.rotation) d.rotation = round(node.rotation)
  if ("opacity" in node && node.opacity !== 1) d.opacity = round(node.opacity)
  d.locked = Boolean(node.locked)
  if (node.visible === false) d.visible = false
  if ("fills" in node) d.fills = paintsOut(node.fills)
  if ("strokes" in node) {
    d.strokes = paintsOut(node.strokes)
    if ("strokeWeight" in node) d.strokeWeight = node.strokeWeight === figma.mixed ? "mixed" : node.strokeWeight
    if ("dashPattern" in node && node.dashPattern && node.dashPattern.length) d.dashPattern = node.dashPattern.slice()
  }
  if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius) d.cornerRadius = node.cornerRadius
  var t = textTarget(node)
  if (t) d.textStyle = textStyleOut(t)
  if (node.type === "STICKY") {
    d.isWideWidth = node.isWideWidth
    d.authorVisible = node.authorVisible
    if (node.authorName) d.authorName = node.authorName
  }
  if (node.type === "CONNECTOR") {
    d.start = endpointOut(node.connectorStart)
    d.end = endpointOut(node.connectorEnd)
    d.startCap = node.connectorStartStrokeCap
    d.endCap = node.connectorEndStrokeCap
    d.label = node.text.characters
  }
  if (node.type === "SECTION") d.contentsHidden = Boolean(node.sectionContentsHidden)
  if (node.type === "CODE_BLOCK") d.code = node.code
  if (node.type === "EMBED") d.embed = node.embedData
  if (node.type === "LINK_UNFURL") d.linkUnfurl = node.linkUnfurlData
  if (node.type === "MEDIA") d.media = node.mediaData
  if (node.type === "VECTOR" || node.type === "HIGHLIGHT") {
    try {
      var paths = JSON.stringify(node.vectorPaths)
      d.paths = paths.length > 4000 ? paths.slice(0, 4000) + "…" : node.vectorPaths
    } catch (error) {
      d.paths = errorText(error)
    }
  }
  if (node.type === "TABLE") d.cells = tableCells(node, 400)
  if ("children" in node && node.type !== "TABLE") {
    d.children = depth > 0
      ? node.children.map(function (c) { return detail(c, depth - 1) })
      : node.children.map(describe)
  }
  return d
}

function textStyleOut(t) {
  var s = {}
  try {
    s.fontName = t.fontName === figma.mixed ? "mixed" : t.fontName
    s.fontSize = t.fontSize === figma.mixed ? "mixed" : t.fontSize
    s.fills = paintsOut(t.fills)
    if (hasProp(t, "textAlignHorizontal")) s.align = t.textAlignHorizontal
    if (hasProp(t, "textAlignVertical")) s.verticalAlign = t.textAlignVertical
    if (hasProp(t, "textAutoResize")) s.autoResize = t.textAutoResize
    var len = t.characters.length
    if (len > 0) {
      var segs = t.getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration", "hyperlink"])
      if (segs.length > 1 || segs.some(function (g) { return g.hyperlink || g.textDecoration !== "NONE" })) {
        s.segments = segs.slice(0, 50).map(function (g) {
          var o = { start: g.start, end: g.end, text: clipText(g.characters), font: g.fontName.family + " " + g.fontName.style, fontSize: g.fontSize }
          var c = paintsOut(g.fills)
          if (c && c[0] && c[0].color) o.color = c[0].color
          if (g.textDecoration && g.textDecoration !== "NONE") o.decoration = g.textDecoration
          if (g.hyperlink) o.link = { type: g.hyperlink.type, value: g.hyperlink.value }
          return o
        })
      }
    }
  } catch (error) {
    s.error = errorText(error)
  }
  return s
}

function tableCells(table, max) {
  var rows = []
  var count = 0
  for (var r = 0; r < table.numRows; r++) {
    var row = []
    for (var c = 0; c < table.numColumns; c++) {
      if (count++ >= max) return { rows: rows, truncated: true }
      var cell = table.cellAt(r, c)
      var o = { text: clipText(cell.text.characters) }
      var fill = paintsOut(cell.fills)
      if (fill && fill[0] && fill[0].color) o.fill = fill[0].color
      row.push(o)
    }
    rows.push(row)
  }
  return { rows: rows }
}

async function getNode(id) {
  var node = await figma.getNodeByIdAsync(String(id))
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("No node with id " + id + " on this board.")
  return node
}

async function getNodes(ids, max) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids must be a non-empty list of node ids.")
  if (max && ids.length > max) throw new Error("At most " + max + " ids per call.")
  var out = []
  for (var i = 0; i < ids.length; i++) out.push(await getNode(ids[i]))
  return out
}

async function getSection(id) {
  var node = await getNode(id)
  if (node.type !== "SECTION") throw new Error("Node " + id + " is a " + node.type + ", not a SECTION.")
  return node
}

async function getPage(input) {
  var pages = figma.root.children
  for (var i = 0; i < pages.length; i++) {
    if ((input.id && pages[i].id === String(input.id)) || (input.name && pages[i].name === String(input.name))) return pages[i]
  }
  throw new Error("No page " + (input.id || input.name) + ". Pages: " + pages.map(function (p) { return p.name + " (" + p.id + ")" }).join(", "))
}

var DEFAULT_FONT = { family: "Inter", style: "Medium" }
var CODE_FONT = { family: "Source Code Pro", style: "Medium" }

// Load the font a text sublayer (sticky, shape, connector label) or text node
// uses. A fresh node can report an empty family or mixed fonts; fall back to
// FigJam's default, Inter Medium, and apply it so the edit can go ahead.
async function loadTextFont(target) {
  var font = target.fontName
  if (font === figma.mixed && typeof target.getRangeAllFontNames === "function" && target.characters.length > 0) {
    await loadAllFonts(target)
    return
  }
  if (!font || font === figma.mixed || !font.family) {
    await figma.loadFontAsync(DEFAULT_FONT)
    target.fontName = DEFAULT_FONT
    return
  }
  await figma.loadFontAsync(font)
}

// Load every font used in the text; any range with an empty family gets Inter Medium.
async function loadAllFonts(target) {
  var len = target.characters.length
  if (len === 0) return loadTextFont(target)
  var fonts = target.getRangeAllFontNames(0, len)
  var broken = false
  for (var i = 0; i < fonts.length; i++) {
    if (!fonts[i] || !fonts[i].family) broken = true
    else await figma.loadFontAsync(fonts[i])
  }
  if (broken) {
    await figma.loadFontAsync(DEFAULT_FONT)
    var segs = target.getStyledTextSegments(["fontName"])
    for (var s = 0; s < segs.length; s++) {
      if (!segs[s].fontName.family) target.setRangeFontName(segs[s].start, segs[s].end, DEFAULT_FONT)
    }
  }
}

async function loadFontFor(node) {
  await loadTextFont(node.text)
}

// Load a font and return the one actually loaded: when the exact style is
// missing but the family exists, the closest style (same italic/bold-ness,
// Regular/Medium preferred) is used instead.
async function loadFont(font) {
  try {
    await figma.loadFontAsync(font)
    return font
  } catch (error) {
    var styles = (await fontList()).filter(function (f) { return f.family.toLowerCase() === String(font.family).toLowerCase() })
    if (styles.length) {
      var best = closestStyle(styles, font.style)
      try {
        await figma.loadFontAsync(best)
        return best
      } catch (error2) {
        // Fall through to the error below.
      }
    }
    throw new Error("Font \"" + font.family + " " + font.style + "\" isn't available: " + errorText(error))
  }
}

function closestStyle(fonts, style) {
  var bold = /bold|black|heavy|semi/i.test(style)
  var italic = /italic/i.test(style)
  function score(f) {
    var s = 0
    if (/italic/i.test(f.style) === italic) s += 4
    if (/bold|black|heavy|semi/i.test(f.style) === bold) s += 2
    if (/^(regular|medium|book|normal)( italic)?$/i.test(f.style)) s += 1
    if (f.style.toLowerCase() === String(style).toLowerCase()) s += 8
    return s
  }
  return fonts.slice().sort(function (a, b) { return score(b) - score(a) })[0]
}

// FigJam's text toolbar fonts -> family + style, first available wins. The
// first entry of each is what FigJam itself uses (read from real stickies);
// the rest are fallbacks for files where it isn't available. bold/italic
// still switch to the family's Bold/Italic styles. calibrate_fonts can
// override these per user.
var FONT_PRESETS = {
  simple: [{ family: "Inter", style: "Medium" }],
  bookish: [{ family: "Merriweather", style: "Regular" }, { family: "Roboto Serif", style: "Regular" }, { family: "Source Serif 4", style: "Regular" }, { family: "Georgia", style: "Regular" }],
  technical: [{ family: "Roboto Mono", style: "Medium" }, { family: "Source Code Pro", style: "Medium" }, { family: "IBM Plex Mono", style: "Medium" }],
  scribbled: [{ family: "Figma Hand", style: "Regular" }, { family: "Caveat", style: "Regular" }, { family: "Patrick Hand", style: "Regular" }],
}
// Toolbar size presets in px, per node type (sticky Small = 16, seen in the
// toolbar). Overridden by sizes learned with calibrate_fonts.
var SIZE_PRESETS = {
  STICKY: { small: 16, medium: 24, large: 40, extralarge: 64, huge: 96 },
  TEXT: { small: 16, medium: 24, large: 40, extralarge: 64, huge: 96 },
  SHAPE_WITH_TEXT: { small: 12, medium: 16, large: 24, extralarge: 40, huge: 64 },
  default: { small: 16, medium: 24, large: 40, extralarge: 64, huge: 96 },
}
var SIZE_ALIASES = { s: "small", sm: "small", m: "medium", md: "medium", l: "large", lg: "large", xl: "extralarge", xlarge: "extralarge", extralarge: "extralarge", h: "huge", xxl: "huge" }
var FONT_STORE_KEY = "maximal.fontPresets"
var FONT_FAMILY = str("Toolbar font: simple (Inter Medium), bookish (Merriweather), technical (Roboto Mono Medium) or scribbled (Figma Hand), or a raw family name. bold/italic pick the family's Bold/Italic style.")
var FONT_SIZE = { type: ["number", "string"], description: "Pixels, or a toolbar preset: small, medium, large, extra large, huge (sticky: 16/24/40/64/96; shape: 12/16/24/40/64)." }
var learnedFonts = null
var availableFonts = null

async function fontMemory() {
  if (!learnedFonts) {
    try {
      learnedFonts = (await figma.clientStorage.getAsync(FONT_STORE_KEY)) || {}
    } catch (error) {
      learnedFonts = {}
    }
    learnedFonts.families = learnedFonts.families || {}
    learnedFonts.sizes = learnedFonts.sizes || {}
  }
  return learnedFonts
}

async function fontList() {
  if (!availableFonts) {
    try {
      availableFonts = (await figma.listAvailableFontsAsync()).map(function (f) { return f.fontName })
    } catch (error) {
      availableFonts = []
    }
  }
  return availableFonts
}

function presetKey(name) {
  var k = normName(name)
  return FONT_PRESETS[k] ? k : undefined
}

function sizeKey(name) {
  var k = normName(name)
  if (SIZE_ALIASES[k]) return SIZE_ALIASES[k]
  return SIZE_PRESETS.default[k] !== undefined ? k : undefined
}

// A toolbar font name or raw family -> { family, style?, preset?, source }.
// available: [{family, style}] (empty = unknown); learned: {preset: {family, style}}.
function pickFamily(name, available, learned) {
  var key = presetKey(name)
  if (!key) return { family: String(name).trim(), source: "raw" }
  if (learned && learned[key] && learned[key].family) return { family: learned[key].family, style: learned[key].style, preset: key, source: "learned" }
  var have = {}
  for (var i = 0; i < available.length; i++) have[available[i].family.toLowerCase()] = true
  var cands = FONT_PRESETS[key]
  if (!available.length) return { family: cands[0].family, style: cands[0].style, preset: key, source: "figjam" }
  for (var c = 0; c < cands.length; c++) {
    if (have[cands[c].family.toLowerCase()]) return { family: cands[c].family, style: cands[c].style, preset: key, source: c === 0 ? "figjam" : "substitute" }
  }
  return { family: DEFAULT_FONT.family, style: DEFAULT_FONT.style, preset: key, source: "fallback" }
}

// A font size value: a number, a numeric string, or a toolbar preset name.
function sizeValue(v, nodeType, learnedSizes) {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number" && isFinite(v) && v > 0) return v
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*(px)?\s*$/i.test(v)) return parseFloat(v)
  var k = typeof v === "string" ? sizeKey(v) : undefined
  if (!k) throw toolError("bad_input", "fontSize \"" + v + "\" must be a number or one of: small, medium, large, extra large, huge.")
  var learned = learnedSizes && learnedSizes[nodeType]
  if (learned && typeof learned[k] === "number") return learned[k]
  return (SIZE_PRESETS[nodeType] || SIZE_PRESETS.default)[k]
}

// A copy of text options with fontFamily presets and fontSize presets resolved.
async function resolveTextOptions(o, nodeType) {
  var out = {}
  for (var k in o) out[k] = o[k]
  delete out.__ramp
  var role = rampRole(o.textStyle)
  if (o.fontSize === undefined && o.fontFamily === undefined && !role) return out
  var mem = await fontMemory()
  if (o.fontSize !== undefined) out.fontSize = sizeValue(o.fontSize, nodeType, mem.sizes)
  if (o.fontFamily) {
    var f = pickFamily(o.fontFamily, presetKey(o.fontFamily) ? await fontList() : [], mem.families)
    out.fontFamily = f.family
    if (f.style && !o.fontStyle && typeof o.bold !== "boolean" && typeof o.italic !== "boolean") out.fontStyle = f.style
  }
  if (role) {
    var notes = []
    var overrides = []
    var available = await fontList()
    var sticky = nodeType === "STICKY"
    if (out.fontFamily === undefined) {
      var rf = pickFamily(role.family, available, mem.families)
      out.fontFamily = rf.family
      if (rf.source === "substitute" || rf.source === "fallback") notes.push(role.family + " family " + FONT_PRESETS[role.family][0].family + " isn't installed; used " + rf.family + ".")
    } else overrides.push("fontFamily")
    if (!o.fontStyle && typeof o.bold !== "boolean" && typeof o.italic !== "boolean") {
      out.fontStyle = rampStyle(out.fontFamily, role.style, available)
      if (out.fontStyle.toLowerCase() !== role.style.toLowerCase()) notes.push(out.fontFamily + " " + role.style + " isn't installed; used " + out.fontStyle + ".")
    } else overrides.push("fontStyle")
    if (o.fontSize === undefined) {
      out.fontSize = sticky ? snapSticky(role.size) : role.size
      if (sticky && out.fontSize !== role.size) notes.push("Sticky text only takes sizes " + STICKY_TEXT_SIZES.join("/") + "; " + role.size + "px snapped to " + out.fontSize + "px.")
    } else overrides.push("fontSize")
    if (sticky) {
      notes.push("Sticky text keeps FigJam's own line height and letter spacing.")
      delete out.lineHeight
      delete out.letterSpacing
    } else {
      // An overridden size keeps the role's leading ratio, on the 4px grid.
      if (o.lineHeight === undefined) out.lineHeight = o.fontSize !== undefined ? Math.ceil(out.fontSize * role.lineHeight / role.size / 4) * 4 : role.lineHeight
      else overrides.push("lineHeight")
      if (o.letterSpacing === undefined) out.letterSpacing = role.letterSpacing
      else overrides.push("letterSpacing")
    }
    if (role.textCase && o.textCase === undefined) out.textCase = role.textCase
    var applied = { fontFamily: out.fontFamily, fontStyle: out.fontStyle, fontSize: out.fontSize }
    if (out.lineHeight !== undefined) applied.lineHeight = out.lineHeight
    if (out.letterSpacing !== undefined) applied.letterSpacing = out.letterSpacing
    if (out.textCase) applied.textCase = out.textCase
    out.__ramp = { role: role.role, applied: applied }
    if (overrides.length) out.__ramp.overridden = overrides
    if (notes.length) out.__ramp.substitutions = notes
  }
  return out
}

// The canvas type ramp: named roles (family preset + style + size + line height
// on a 4px grid + letter spacing %, optional case). textStyle on the text tools
// applies a role; explicit fontSize/fontFamily/fontStyle/lineHeight/
// letterSpacing alongside it override that property.
var TYPE_RAMP = [
  { role: "display", family: "simple", style: "Bold", size: 96, lineHeight: 104, letterSpacing: -2, use: "One per board: the title of a huge map." },
  { role: "title", family: "simple", style: "Bold", size: 64, lineHeight: 72, letterSpacing: -1.5, use: "Board / page title." },
  { role: "headline", family: "simple", style: "Semi Bold", size: 40, lineHeight: 48, letterSpacing: -1, use: "Major area headings." },
  { role: "section", family: "simple", style: "Semi Bold", size: 28, lineHeight: 36, letterSpacing: -0.5, use: "Section/area headings on canvas." },
  { role: "subhead", family: "simple", style: "Medium", size: 20, lineHeight: 28, letterSpacing: 0, use: "Subheadings, card titles." },
  { role: "body-lg", family: "simple", style: "Regular", size: 18, lineHeight: 28, letterSpacing: 0, use: "Lead text, text on big shapes." },
  { role: "body", family: "simple", style: "Regular", size: 16, lineHeight: 24, letterSpacing: 0, use: "Body text, shape text, card descriptions." },
  { role: "caption", family: "simple", style: "Regular", size: 13, lineHeight: 20, letterSpacing: 0.5, use: "Captions, secondary card descriptions." },
  { role: "label", family: "simple", style: "Semi Bold", size: 12, lineHeight: 16, letterSpacing: 4, textCase: "UPPER", use: "Tags, legend keys." },
  { role: "quote", family: "bookish", style: "Regular", size: 24, lineHeight: 36, letterSpacing: 0, use: "Quotes, verbatims." },
  { role: "code", family: "technical", style: "Regular", size: 14, lineHeight: 20, letterSpacing: 0, use: "Inline code, paths, values." },
  { role: "code-label", family: "technical", style: "Medium", size: 16, lineHeight: 24, letterSpacing: 0, use: "Tool/identifier names on cards." },
  { role: "note", family: "scribbled", style: "Regular", size: 20, lineHeight: 28, letterSpacing: 0, use: "Handwritten annotations." },
]
// Fallback order when a role's style isn't installed in its family.
var STYLE_FALLBACKS = {
  "semi bold": ["SemiBold", "Semibold", "Bold", "Medium", "Regular"],
  bold: ["Semi Bold", "SemiBold", "Extra Bold", "Medium", "Regular"],
  medium: ["Regular", "Semi Bold", "Bold"],
  regular: ["Book", "Normal", "Medium"],
}
// FigJam sticky text only takes the sticky toolbar sizes (and keeps its own
// line height), so ramp sizes on stickies snap to the nearest of these.
var STICKY_TEXT_SIZES = [16, 24, 40, 64, 96]
var TEXT_STYLE = str("Type ramp role (see type_ramp): display, title, headline, section, subhead, body-lg, body, caption, label, quote, code, code-label, note. Sets family, style, size, line height, letter spacing and case; explicit fontSize/fontFamily/fontStyle/lineHeight/letterSpacing override that part.")

function rampRole(name) {
  if (name === undefined || name === null || name === "") return undefined
  var k = String(name).trim().toLowerCase().replace(/[\s_]+/g, "-")
  for (var i = 0; i < TYPE_RAMP.length; i++) if (TYPE_RAMP[i].role.replace(/-/g, "") === k.replace(/-/g, "")) return TYPE_RAMP[i]
  throw toolError("bad_input", "textStyle \"" + name + "\" isn't a ramp role. Use one of: " + TYPE_RAMP.map(function (r) { return r.role }).join(", ") + ".")
}

function snapSticky(size) {
  var best = STICKY_TEXT_SIZES[0]
  for (var i = 1; i < STICKY_TEXT_SIZES.length; i++) {
    if (Math.abs(STICKY_TEXT_SIZES[i] - size) <= Math.abs(best - size)) best = STICKY_TEXT_SIZES[i]
  }
  return best
}

// The installed style closest to `want` in `family` (available empty = unknown: keep it).
function rampStyle(family, want, available) {
  var styles = available.filter(function (f) { return f.family.toLowerCase() === String(family).toLowerCase() }).map(function (f) { return f.style })
  if (!styles.length) return want
  function has(s) { for (var i = 0; i < styles.length; i++) if (styles[i].toLowerCase() === s.toLowerCase()) return styles[i] }
  if (has(want)) return has(want)
  var chain = STYLE_FALLBACKS[want.toLowerCase()] || ["Regular", "Medium"]
  for (var c = 0; c < chain.length; c++) if (has(chain[c])) return has(chain[c])
  return styles[0]
}

function familyInPreset(family, preset) {
  var f = String(family || "").toLowerCase()
  var learned = learnedFonts && learnedFonts.families && learnedFonts.families[preset]
  if (learned && learned.family && learned.family.toLowerCase() === f) return true
  return FONT_PRESETS[preset].some(function (c) { return c.family.toLowerCase() === f })
}

// The ramp role a text's size + family matches, else undefined.
function rampMatch(size, family, sticky) {
  for (var i = 0; i < TYPE_RAMP.length; i++) {
    var r = TYPE_RAMP[i]
    var s = sticky ? snapSticky(r.size) : r.size
    if (Math.abs(s - size) < 0.5 && familyInPreset(family, r.family)) return r
  }
}

// The nearest role for off-ramp text: same family preset first, then nearest size.
function nearestRole(size, family) {
  var same = TYPE_RAMP.filter(function (r) { return familyInPreset(family, r.family) })
  var pool = same.length ? same : TYPE_RAMP.filter(function (r) { return r.family === "simple" })
  return pool.slice().sort(function (a, b) { return Math.abs(a.size - size) - Math.abs(b.size - size) || b.size - a.size })[0]
}

function rampOut() {
  return TYPE_RAMP.map(function (r) {
    var o = { role: r.role, family: r.family, fontFamily: FONT_PRESETS[r.family][0].family, fontStyle: r.style, fontSize: r.size, lineHeight: r.lineHeight, letterSpacing: r.letterSpacing, stickySize: snapSticky(r.size), use: r.use }
    if (r.textCase) o.textCase = r.textCase
    return o
  })
}

// Copy a resolved ramp report (o.__ramp) onto a tool result.
function withRamp(result, o) {
  if (o && o.__ramp) result.ramp = o.__ramp
  return result
}

// Only the typographic part of resolved options (so color etc. isn't re-applied).
function rampOpts(o) {
  var out = {}
  ;["fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "textCase", "bold", "italic"].forEach(function (k) { if (o[k] !== undefined) out[k] = o[k] })
  return out
}

// Apply resolved font options to all of a text target (empty text included).
async function styleWhole(t, o) {
  await loadAllFonts(t)
  var len = t.characters.length
  if (len === 0) {
    if (hasFontChange(o)) t.fontName = await loadFont(resolveFont(t.fontName, o))
    if (typeof o.fontSize === "number") t.fontSize = o.fontSize
    return
  }
  await styleRange(t, 0, len, o)
}

function viewportCenter() {
  try {
    return figma.viewport.center
  } catch (error) {
    return { x: 0, y: 0 }
  }
}

function viewportBounds() {
  try {
    var v = figma.viewport.bounds
    return { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.width), height: Math.round(v.height) }
  } catch (error) {
    return undefined
  }
}

// Top-left of empty space to the right of everything on the page.
function freeSpot() {
  var kids = activePage().children
  if (kids.length === 0) {
    var c = viewportCenter()
    return { x: Math.round(c.x - 200), y: Math.round(c.y - 200) }
  }
  var right = -Infinity
  var top = Infinity
  for (var i = 0; i < kids.length; i++) {
    right = Math.max(right, kids[i].x + kids[i].width)
    top = Math.min(top, kids[i].y)
  }
  return { x: Math.round(right + 160), y: Math.round(top) }
}

// Grow a section so it holds all its children with padding.
function fitSection(section) {
  var maxRight = 0
  var maxBottom = 0
  for (var i = 0; i < section.children.length; i++) {
    var c = section.children[i]
    maxRight = Math.max(maxRight, c.x + c.width)
    maxBottom = Math.max(maxBottom, c.y + c.height)
  }
  var w = Math.max(section.width, maxRight + PAD)
  var hgt = Math.max(section.height, maxBottom + PAD)
  if (w !== section.width || hgt !== section.height) section.resizeWithoutConstraints(w, hgt)
}

// Shrink or grow a section to exactly its contents plus padding, keeping
// every child where it is on the page.
function fitSectionTight(section, pad, headerGap) {
  var kids = section.children
  if (kids.length === 0) return
  var p = typeof pad === "number" ? pad : PAD
  var minX = Infinity
  var minY = Infinity
  var maxX = -Infinity
  var maxY = -Infinity
  for (var i = 0; i < kids.length; i++) {
    minX = Math.min(minX, kids[i].x)
    minY = Math.min(minY, kids[i].y)
    maxX = Math.max(maxX, kids[i].x + kids[i].width)
    maxY = Math.max(maxY, kids[i].y + kids[i].height)
  }
  var top = p + (typeof headerGap === "number" ? headerGap : 0)
  var dx = minX - p
  var dy = minY - top
  section.x += dx
  section.y += dy
  for (var k = 0; k < kids.length; k++) {
    kids[k].x -= dx
    kids[k].y -= dy
  }
  section.resizeWithoutConstraints(Math.max(1, maxX - minX + 2 * p), Math.max(1, maxY - minY + p + top))
}

// Place nodes left-to-right in rows using their real sizes (two-pass layout).
function layoutGrid(nodes, originX, originY, columns, gap) {
  var g = typeof gap === "number" ? gap : GAP
  var cols = Math.max(1, columns || Math.ceil(Math.sqrt(nodes.length)))
  var y = originY
  for (var r = 0; r * cols < nodes.length; r++) {
    var row = nodes.slice(r * cols, r * cols + cols)
    var x = originX
    var rowH = 0
    for (var i = 0; i < row.length; i++) {
      row[i].x = x
      row[i].y = y
      x += row[i].width + g
      rowH = Math.max(rowH, row[i].height)
    }
    y += rowH + g
  }
}

// Page-space bounds of a node.
function bbox(node) {
  var b = node.absoluteBoundingBox
  if (b) return b
  var t = node.absoluteTransform
  return { x: t[0][2], y: t[1][2], width: node.width, height: node.height }
}

function unionBox(nodes) {
  var minX = Infinity
  var minY = Infinity
  var maxX = -Infinity
  var maxY = -Infinity
  for (var i = 0; i < nodes.length; i++) {
    var b = bbox(nodes[i])
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// Move a node so its page-space bounding box starts at (ax, ay).
function moveAbs(node, ax, ay) {
  var b = bbox(node)
  node.x += ax - b.x
  node.y += ay - b.y
}

// Rotate about the node's center (Figma's `rotation` pivots on the top-left).
function rotateAboutCenter(node, degrees) {
  var w = node.width
  var hh = node.height
  var t = node.relativeTransform
  var cx = t[0][2] + t[0][0] * w / 2 + t[0][1] * hh / 2
  var cy = t[1][2] + t[1][0] * w / 2 + t[1][1] * hh / 2
  node.rotation = degrees
  var n = node.relativeTransform
  node.x = cx - (n[0][0] * w / 2 + n[0][1] * hh / 2)
  node.y = cy - (n[1][0] * w / 2 + n[1][1] * hh / 2)
}

// Put a new node either in a section (section-local coordinates) or on the page.
async function place(node, input) {
  if (input.sectionId) {
    var section = await getSection(input.sectionId)
    section.appendChild(node)
    if (typeof input.x === "number" && typeof input.y === "number") {
      node.x = input.x
      node.y = input.y
    } else {
      // Below the section's current content.
      var bottom = PAD
      for (var i = 0; i < section.children.length; i++) {
        var c = section.children[i]
        if (c !== node) bottom = Math.max(bottom, c.y + c.height + GAP)
      }
      node.x = PAD
      node.y = bottom
    }
    fitSection(section)
    return
  }
  if (node.parent !== activePage()) activePage().appendChild(node)
  if (typeof input.x === "number" && typeof input.y === "number") {
    node.x = input.x
    node.y = input.y
  } else {
    var spot = freeSpot()
    node.x = spot.x
    node.y = spot.y
  }
}

function base64ToBytes(b64) {
  var clean = String(b64).replace(/^data:[^,]*,/, "").replace(/\s+/g, "")
  return figma.base64Decode(clean)
}

// ------------------------------------------------------------------ tool registry
//
// tool(name, description, properties, required, fn, options)
// options.readOnly: the tool doesn't change the document (no undo step).

var tools = {}
var toolSpecs = []
var toolMeta = {}

// Tools that change or remove existing content (see guardDestructive).
var DESTRUCTIVE = { delete_nodes: true, ungroup: true, rename_page: true, run_code: true, convert_node: true, unlock_all: true }
var CLIENT_ID_KEY = "maximal.clientId"
// Tools about the user's own view/selection or the page list: no page targeting.
var NO_PAGE_TARGET = { get_selection: true, select: true, focus: true, switch_page: true, create_page: true, list_pages: true, batch: true,
  // Comments belong to the file, not a page.
  get_comments: true, add_comment: true, react_to_comment: true }

// ------------------------------------------------------------------ page targeting
//
// A call with pageId/pageName acts on that page without switching the user's
// view: TARGET_PAGE is set for the call and activePage() returns it. Targeted
// calls take the page lock exclusively (one at a time, no other call in flight);
// untargeted calls share it, so TARGET_PAGE never leaks into an interleaved call.
var TARGET_PAGE = null
function activePage() { return TARGET_PAGE || figma.currentPage }

var pageLock = { readers: 0, writer: false, waiting: [] }
function pageLockPump() {
  while (pageLock.waiting.length && !pageLock.writer) {
    var next = pageLock.waiting[0]
    if (next.exclusive) {
      if (pageLock.readers) return
      pageLock.writer = true
    } else pageLock.readers++
    pageLock.waiting.shift()
    next.resolve()
  }
}
function withPageLock(exclusive, fn) {
  return new Promise(function (resolve) {
    pageLock.waiting.push({ exclusive: exclusive, resolve: resolve })
    pageLockPump()
  }).then(fn).then(function (value) {
    release()
    return value
  }, function (error) {
    release()
    throw error
  })
  function release() {
    if (exclusive) pageLock.writer = false
    else pageLock.readers--
    pageLockPump()
  }
}

function wantsPage(name, input) {
  if (!isPlainObject(input)) return false
  if (name === "batch") return Array.isArray(input.calls) && input.calls.some(function (c) { return c && wantsPage(c.name, c.input) })
  return Boolean(tools[name] && !toolMeta[name].ownsPage && (input.pageId || input.pageName))
}

async function resolveTargetPage(input) {
  var page = null
  if (input.pageId) {
    page = await figma.getNodeByIdAsync(String(input.pageId))
    if (!page || page.type !== "PAGE") throw toolError("not_found", "No page with id " + input.pageId + ".")
  } else {
    var name = String(input.pageName)
    page = figma.root.children.filter(function (p) { return p.name === name })[0]
    if (!page) throw toolError("not_found", "No page named \"" + name + "\". Pages: " + figma.root.children.map(function (p) { return p.name + " (" + p.id + ")" }).join(", "))
  }
  if (page !== figma.currentPage) await page.loadAsync()
  return page
}

// figma.createX() appends to figma.currentPage: move what a targeted call
// left there (new top-level nodes) onto the target page, same position.
function adoptStrays(host, before, page) {
  var kids = host.children.slice()
  for (var i = 0; i < kids.length; i++) if (!before[kids[i].id]) page.appendChild(kids[i])
}

var EXPECT_SCHEMA = {
  type: "object",
  description: "Preconditions, checked before anything changes; on mismatch nothing changes and the result is {ok: false, code: \"precondition_failed\", mismatches}. Pass pageId (the page you read), revs {nodeId: rev} for the nodes you change (revs come from your last read), names {nodeId: name} (pages too), absent [ids] that must not exist, fileKey/boardId to pin the file.",
  properties: {
    fileKey: str(), boardId: str(), pageId: str(),
    revs: { type: "object", description: "{nodeId: rev} from your last read." },
    names: { type: "object", description: "{nodeId: name}." },
    absent: arr(str(), "Ids that must not exist."),
  },
}

var PAGE_TARGET_DESC = "Act on this page without switching the user's view"
function tool(name, description, properties, required, fn, options) {
  properties = Object.assign({}, properties)
  options = Object.assign({}, options)
  // Tools with their own pageId/pageName (move_to, rename_page, readers with a
  // page option) keep that meaning; every other tool gets central page targeting.
  if (properties.pageId || properties.pageName) options.ownsPage = true
  else if (!NO_PAGE_TARGET[name]) {
    properties.pageId = str(PAGE_TARGET_DESC + " (page id from list_pages or a result's target.pageId).")
    properties.pageName = str(PAGE_TARGET_DESC + " (exact page name; alternative to pageId).")
  }
  if (!(options && options.readOnly)) {
    properties.expect = EXPECT_SCHEMA
    if (DESTRUCTIVE[name] || name === "edit_table" || name === "move_to") properties.confirm = bool("Required (or expect) for remote agents: the user explicitly asked for this.")
    if (isCreateTool(name)) properties.clientId = str("Your idempotency key: a retry with the same clientId returns the node(s) already made (changed: false) instead of duplicating.")
  }
  var schema = { type: "object", properties: properties }
  if (required && required.length) schema.required = required
  toolSpecs.push({ name: name, description: description, input_schema: schema })
  tools[name] = fn
  toolMeta[name] = options
}

// Schema shorthands.
function str(description) { return description ? { type: "string", description: description } : { type: "string" } }
function num(description) { return description ? { type: "number", description: description } : { type: "number" } }
function int(description) { return description ? { type: "integer", description: description } : { type: "integer" } }
function bool(description) { return description ? { type: "boolean", description: description } : { type: "boolean" } }
function arr(items, description) {
  var o = { type: "array", items: items }
  if (description) o.description = description
  return o
}
function obj(properties, description) {
  var o = { type: "object", properties: properties }
  if (description) o.description = description
  return o
}
var POINT = { x: num(), y: num() }
var IDS = arr(str(), "Node ids.")
var X = num("Page x, or section-relative x with sectionId.")
var Y = num("Page y, or section-relative y with sectionId.")
var SECTION_ID = str("Put it in this section (x/y then section-relative; omitted x/y = below existing content).")
var MAGNET_DESC = "AUTO (default), TOP, BOTTOM, LEFT, RIGHT, CENTER or NONE."
var CAPS = ["NONE", "ARROW_LINES", "ARROW_EQUILATERAL", "TRIANGLE_FILLED", "DIAMOND_FILLED", "CIRCLE_FILLED", "ERD_ZERO_OR_ONE", "ERD_EXACTLY_ONE", "ERD_ZERO_OR_MORE", "ERD_ONE_OR_MORE", "ERD_ONE", "ERD_MANY"]
var CAP_DESC = CAPS.join(", ") + "."
var SHAPES = ["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"]
var LANGUAGES = ["TYPESCRIPT", "JAVASCRIPT", "PYTHON", "GO", "RUST", "RUBY", "CSS", "HTML", "JSON", "GRAPHQL", "SQL", "SWIFT", "KOTLIN", "CPP", "BASH", "DART", "PLAINTEXT"]

function oneOf(list, value, what) {
  var v = String(value).toUpperCase()
  if (list.indexOf(v) < 0) throw new Error("Unknown " + what + " \"" + value + "\". Use one of: " + list.join(", "))
  return v
}

// Text styling options shared by style_text and its ranges.
var TEXT_STYLE_PROPS = {
  textStyle: TEXT_STYLE,
  fontSize: FONT_SIZE,
  fontFamily: FONT_FAMILY,
  fontStyle: str("Exact style name, e.g. Regular, Medium, Bold, Bold Italic. Overrides bold/italic."),
  bold: bool(),
  italic: bool(),
  color: str("Hex like #1E1E1E."),
  underline: bool(),
  strikethrough: bool(),
  url: str("Make the text a link to this URL (empty string removes the link)."),
}

// ------------------------------------------------------------------ tools: reading

tool("get_board",
  "List the nodes on the current FigJam page (sections and groups are expanded), with ids, types, text, colors, positions, sizes and rev, plus the current selection ids, the viewport, and the board url (null + urlHint when unknown: ask the user for the share link and call set_board_url). Every result carries target {fileKey, boardId, fileName, pageId, pageName}: check it is the board/page you mean. When you then change nodes, pass expect {pageId, revs: {id: rev}} so nothing changes if someone edited them meanwhile, and clientId on creates so retries don't duplicate. For structure prefer board_tree; for what people drew/highlighted use read_markup.",
  { limit: int("Max nodes to return (default 150, max 400).") }, [],
  async function (input) {
    var limit = Math.min(Math.max(Number(input.limit) || 150, 1), 400)
    var out = []
    var total = 0
    function walk(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        total++
        if (out.length < limit) out.push(describe(nodes[i]))
        if (nodes[i].type === "SECTION" || nodes[i].type === "GROUP") walk(nodes[i].children)
      }
    }
    walk(activePage().children)
    var link = boardUrl()
    return {
      page: activePage().name,
      pageId: activePage().id,
      url: link.url,
      urlHint: link.url ? undefined : link.hint,
      nodes: out,
      totalNodes: total,
      truncated: total > out.length,
      selection: figma.currentPage.selection.map(function (n) { return n.id }),
      viewport: viewportBounds(),
    }
  }, { readOnly: true })

tool("get_selection", "Describe the nodes the user has selected (section and group children included).", {}, [],
  async function () {
    return figma.currentPage.selection.map(function (n) {
      var d = describe(n)
      if (n.type === "SECTION" || n.type === "GROUP") d.children = n.children.map(describe)
      return d
    })
  }, { readOnly: true })

tool("get_node",
  "Full detail for one or more nodes: fills, strokes, dash pattern, opacity, rotation, lock, text style and styled segments (fonts, colors, links), connector endpoints/magnets/caps, sticky options, section contents, table cells, code, page and parent.",
  { id: str(), ids: IDS, depth: int("Child levels to detail for sections/groups (default 0 = children summarized; max 3).") }, [],
  async function (input) {
    var depth = Math.min(Math.max(Number(input.depth) || 0, 0), 3)
    if (input.id) return detail(await getNode(input.id), depth)
    return (await getNodes(input.ids, 50)).map(function (n) { return detail(n, depth) })
  }, { readOnly: true })

tool("find_nodes",
  "Find nodes by type, name and/or text (case-insensitive substrings) on the current page, another page, or within a section/group.",
  {
    types: arr(str(), "Node types, e.g. STICKY, SHAPE_WITH_TEXT, CONNECTOR, SECTION, TEXT, TABLE, CODE_BLOCK, GROUP, STAMP, LINK_UNFURL, EMBED, MEDIA, RECTANGLE."),
    name: str("Substring of the layer name."),
    text: str("Substring of the text content."),
    withinId: str("Search only inside this section/group."),
    pageId: str("Search this page instead of the current one."),
    limit: int("Default 100, max 500."),
  }, [],
  async function (input) {
    var root
    if (input.withinId) {
      root = await getNode(input.withinId)
      if (!("findAll" in root)) throw new Error(root.type + " has no children to search.")
    } else if (input.pageId) {
      root = await getPage({ id: input.pageId })
      await root.loadAsync()
    } else root = activePage()
    var types = Array.isArray(input.types) && input.types.length ? input.types.map(function (t) { return String(t).toUpperCase() }) : undefined
    var found = types ? root.findAllWithCriteria({ types: types }) : root.findAll()
    var name = input.name ? String(input.name).toLowerCase() : undefined
    var text = input.text ? String(input.text).toLowerCase() : undefined
    var limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500)
    var out = []
    var total = 0
    for (var i = 0; i < found.length; i++) {
      var n = found[i]
      if (name && String(n.name).toLowerCase().indexOf(name) < 0) continue
      if (text) {
        var t = textOf(n)
        if (typeof t !== "string" || t.toLowerCase().indexOf(text) < 0) continue
      }
      total++
      if (out.length < limit) out.push(describe(n))
    }
    return { nodes: out, total: total, truncated: total > out.length }
  }, { readOnly: true })

tool("list_pages", "List the pages in this file: id, name, node count (all nodes, nested included) and which one is current.", {}, [],
  async function () {
    var out = []
    var pages = figma.root.children
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i]
      var o = { id: p.id, name: p.name, rev: rev(p), current: p === figma.currentPage }
      try {
        if (p !== figma.currentPage) await p.loadAsync()
        o.topLevelCount = p.children.length
        o.nodeCount = p.findAll().length
      } catch (error) {
        o.countError = errorText(error)
      }
      out.push(o)
    }
    return out
  }, { readOnly: true })

tool("switch_page", "Make another page current (by id or exact name). All tools then work on that page.",
  { id: str(), name: str() }, [],
  async function (input) {
    var page = await getPage(input)
    var changed = page !== figma.currentPage
    if (changed) await figma.setCurrentPageAsync(page)
    return { id: page.id, name: page.name, rev: rev(page), changed: changed, childCount: page.children.length }
  }, { readOnly: true })

tool("rename_page", "Rename a page, idempotently and guarded against renaming the wrong one. Pass pageId (from list_pages or a result's target.pageId) and from (the name you saw): if the page already has `name` it's a no-op (changed: false); if its name is neither `from` nor `name`, nothing changes (precondition_failed). pageId may be omitted only with from or expect.pageId (then: the current page) or when the file has one page. Give pages meaningful names (\"Retro – Sprint 12\", \"Checkout flow\"), not \"Page 2\".",
  { pageId: str("Page id."), page: str("Alternative to pageId: page id or exact current name."), name: str("New name."), from: str("The page's current name as you last read it.") }, ["name"],
  async function (input) {
    var name = String(input.name || "").trim()
    if (!name) throw toolError("bad_input", "name can't be empty.")
    var pages = figma.root.children
    var page
    if (input.pageId) page = await getPage({ id: input.pageId })
    else if (input.page) page = await getPage({ id: input.page, name: input.page })
    else if (input.from !== undefined || (input.expect && input.expect.pageId) || pages.length === 1) page = activePage()
    else {
      throw toolError("bad_input", "This file has " + pages.length + " pages: pass pageId (or from / expect.pageId for the current page). Pages: " + pages.map(function (p) { return p.name + " (" + p.id + ")" }).join(", "))
    }
    var out = { id: page.id, current: page === figma.currentPage, link: nodeLink(page.id) }
    if (page.name === name) {
      out.changed = false
      out.name = page.name
      out.rev = rev(page)
      return out
    }
    if (input.from !== undefined && page.name !== String(input.from)) {
      throw toolError("precondition_failed", "Nothing changed: page " + page.id + " is named \"" + page.name + "\", not \"" + input.from + "\".", { mismatches: [{ field: "names", id: page.id, expected: String(input.from), actual: page.name }] })
    }
    out.previousName = page.name
    page.name = name
    out.changed = true
    out.name = page.name
    out.rev = rev(page)
    return out
  })

tool("create_page", "Add a named page to this file and (by default) switch to it, so the following tools work there. Use a new page for a distinct, large artifact (a new workshop, diagram, or plan) when the user asks for something new; keep small additions on the current page.",
  { name: str("Page name (meaningful, e.g. \"User journey\")."), switchTo: bool("Make it the current page (default true).") }, [],
  async function (input) {
    var page = figma.createPage()
    if (input.name && String(input.name).trim()) page.name = String(input.name).trim()
    if (input.switchTo !== false) await figma.setCurrentPageAsync(page)
    return { id: page.id, name: page.name, current: page === figma.currentPage, link: nodeLink(page.id) }
  })

// ------------------------------------------------------------------ tools: creating

tool("create_stickies",
  "Create one or more sticky notes, laid out in a grid. Optionally inside a section (placed below its existing content). Vary colors by meaning (e.g. green=positive, pink=concern, red=blocker, blue=discussion, violet=idea, yellow=question) rather than all yellow; use wide stickies for longer text (~20+ words); hide the author line for clean facilitator content.",
  {
    items: arr(obj({
      text: str(),
      color: str("Sticky palette color name or hex."),
      wide: bool("Wide sticky (2x width), for longer text (~20+ words)."),
      authorVisible: bool("Show the author line."),
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      textStyle: TEXT_STYLE,
    }), "Stickies to create (objects, or plain strings)."),
    textStyle: str("Default type ramp role for items without one (see type_ramp). Sticky text only takes sizes 16/24/40/64/96, so role sizes snap to the nearest (reported in ramp)."),
    fontFamily: str("Default toolbar font for items without one: simple, bookish, technical, scribbled, or a family name."),
    fontSize: { type: ["number", "string"], description: "Default size for items without one: px or small (16), medium, large, extra large, huge." },
    color: str("Default color for items without one (default yellow)."),
    wide: bool("Default wide setting for items without one. Default: wide when the text is over ~120 characters."),
    authorVisible: bool("Default author-line visibility for items without one (false hides it)."),
    sectionId: str("Put the stickies in this section."),
    columns: int("Grid columns (default: roughly square)."),
    x: num(),
    y: num(),
  }, ["items"],
  async function (input) {
    var items = input.items
    if (!Array.isArray(items) || items.length === 0) throw new Error("items must be a non-empty list.")
    if (items.length > 50) throw new Error("At most 50 stickies per call.")
    var made = []
    var ramps = []
    for (var i = 0; i < items.length; i++) {
      var item = typeof items[i] === "string" ? { text: items[i] } : items[i]
      var sticky = figma.createSticky()
      await loadFontFor(sticky)
      sticky.text.characters = String(item.text || "")
      sticky.fills = [solid(item.color || input.color || "yellow", STICKY)]
      var wide = typeof item.wide === "boolean" ? item.wide : typeof input.wide === "boolean" ? input.wide : String(item.text || "").length > 120
      if (wide) sticky.isWideWidth = true
      var author = typeof item.authorVisible === "boolean" ? item.authorVisible : input.authorVisible
      if (typeof author === "boolean") sticky.authorVisible = author
      var fam = item.fontFamily || input.fontFamily
      var size = item.fontSize !== undefined ? item.fontSize : input.fontSize
      var role = item.textStyle || input.textStyle
      if (fam || size !== undefined || role) {
        var so = await resolveTextOptions({ fontFamily: fam, fontSize: size, textStyle: role }, "STICKY")
        await styleWhole(sticky.text, rampOpts(so))
        if (so.__ramp) ramps.push(so.__ramp)
      }
      made.push(sticky)
    }
    var section
    var origin
    if (input.sectionId) {
      section = await getSection(input.sectionId)
      var bottom = PAD
      for (var s = 0; s < section.children.length; s++) {
        bottom = Math.max(bottom, section.children[s].y + section.children[s].height + GAP)
      }
      for (var k = 0; k < made.length; k++) section.appendChild(made[k])
      origin = { x: typeof input.x === "number" ? input.x : PAD, y: typeof input.y === "number" ? input.y : bottom }
    } else {
      for (var m = 0; m < made.length; m++) if (made[m].parent !== activePage()) activePage().appendChild(made[m])
      origin = typeof input.x === "number" && typeof input.y === "number" ? { x: input.x, y: input.y } : freeSpot()
    }
    layoutGrid(made, origin.x, origin.y, input.columns)
    if (section) fitSection(section)
    var res = { created: made.map(describe) }
    if (ramps.length) res.ramp = ramps[0]
    return res
  })

tool("create_section", "Create a section (a titled, tinted area that groups content).",
  {
    name: str(),
    color: str("Section tint name (default gray) or hex."),
    width: num("Default 800."),
    height: num("Default 500."),
    x: num(),
    y: num(),
    contentsHidden: bool("Hide the section's contents."),
    textStyle: str("Ignored: FigJam's API can't style section titles (fixed style). For a ramp heading inside, add create_text textStyle section."),
  }, ["name"],
  async function (input) {
    var section = figma.createSection()
    if (section.parent !== activePage()) activePage().appendChild(section)
    section.name = String(input.name || "Section")
    section.fills = [solid(input.color || "gray", SECTION)]
    section.resizeWithoutConstraints(Number(input.width) || 800, Number(input.height) || 500)
    if (typeof input.x === "number" && typeof input.y === "number") {
      section.x = input.x
      section.y = input.y
    } else {
      var spot = freeSpot()
      section.x = spot.x
      section.y = spot.y
    }
    if (input.contentsHidden) section.sectionContentsHidden = true
    var sd = describe(section)
    if (input.textStyle) sd.ramp = { role: String(input.textStyle), applied: null, substitutions: ["Section titles use FigJam's fixed style; the plugin API can't set their font. Use create_text with textStyle for an on-canvas heading."] }
    return sd
  })

// FigJam's toolbar fill modes (fill / transparent / no fill) and stroke modes
// (solid / dashed / none), applied after any color options.
function applyPaintModes(node, input) {
  if (input.fillMode) {
    var mode = oneOf(["FILL", "TRANSPARENT", "NONE"], input.fillMode, "fillMode")
    if (!("fills" in node)) throw new Error(node.type + " has no fill.")
    if (mode === "NONE") node.fills = []
    else {
      var c = solidColor(node.fills) || WHITE
      node.fills = [{ type: "SOLID", color: c, opacity: mode === "TRANSPARENT" ? TRANSPARENT_OPACITY : 1 }]
    }
  }
  if (input.strokeMode) {
    var sm = oneOf(["SOLID", "DASHED", "NONE"], input.strokeMode, "strokeMode")
    if (!("strokes" in node)) throw new Error(node.type + " has no stroke.")
    if (sm === "NONE") node.strokes = []
    else {
      if (!solidColor(node.strokes)) node.strokes = [{ type: "SOLID", color: h(0xb3, 0xb3, 0xb3) }]
      if ("dashPattern" in node) node.dashPattern = sm === "DASHED" ? DASHED : []
    }
  }
}

function applyShapeColors(shape, input, defaultColor) {
  if (input.color || defaultColor) {
    var preset = isHex(input.color) ? undefined : pick(SHAPE, input.color, defaultColor)
    if (preset) {
      shape.fills = [{ type: "SOLID", color: preset.fill }]
      shape.strokes = [{ type: "SOLID", color: preset.stroke }]
      shape.text.fills = [{ type: "SOLID", color: preset.text }]
    } else shape.fills = [solid(input.color)]
  }
  if (input.fill) shape.fills = [solid(input.fill, SHAPE, "fill")]
  if (input.stroke) shape.strokes = [solid(input.stroke, SHAPE, "stroke")]
  if (input.textColor) shape.text.fills = [solid(input.textColor, SHAPE, "text")]
}

tool("create_shape", "Create a shape with text (flowcharts, diagrams, journey steps, architecture). Any FigJam shape type (DIAMOND for decisions, ENG_DATABASE for stores, ELLIPSE for start/end…), preset color or custom hex fill/stroke/text, dashes, size. For flows: ≥ 160×80, textStyle body or body-lg, gaps ≥ 64px so connectors read as arrows; color by one meaning (stage/status/owner) with ≤ 4 hues + a legend, otherwise a single neutral (white/gray).",
  {
    text: str(),
    shape: str("Shape type: " + SHAPES.join(", ") + ". Default ROUNDED_RECTANGLE."),
    color: str("Shape preset name (default white): sets fill, stroke and text color together."),
    fill: str("Custom fill (hex or preset name)."),
    stroke: str("Custom stroke (hex or preset name)."),
    textColor: str("Custom text color (hex or preset name)."),
    strokeWeight: num(),
    dashPattern: arr(num(), "e.g. [10, 6]; [] for solid."),
    fillMode: str("Toolbar fill mode: fill (solid, default), transparent (translucent tint of the fill color) or none."),
    strokeMode: str("Toolbar stroke mode: solid, dashed or none."),
    fontSize: { type: ["number", "string"], description: "Default 16 (18 on shapes ≥ 240×120), or a toolbar preset: small, medium, large, extra large, huge." },
    fontFamily: FONT_FAMILY,
    textStyle: TEXT_STYLE,
    width: num("Default 200."),
    height: num("Default 120."),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, ["text"],
  async function (input) {
    var type = oneOf(SHAPES, input.shape || "ROUNDED_RECTANGLE", "shape")
    input = await resolveTextOptions(input, "SHAPE_WITH_TEXT")
    var shape = figma.createShapeWithText()
    shape.shapeType = type
    await loadFontFor(shape)
    shape.text.characters = String(input.text || "")
    // Readable by default: 16px, 18px on big shapes (FigJam's default is small).
    var big = (Number(input.width) || 200) >= 240 && (Number(input.height) || 120) >= 120
    shape.text.fontSize = typeof input.fontSize === "number" ? input.fontSize : big ? 18 : 16
    applyShapeColors(shape, input, "white")
    if (typeof input.strokeWeight === "number") shape.strokeWeight = input.strokeWeight
    if (Array.isArray(input.dashPattern)) shape.dashPattern = input.dashPattern
    applyPaintModes(shape, input)
    if (input.__ramp) await styleWhole(shape.text, rampOpts(input))
    else if (input.fontFamily) await styleWhole(shape.text, { fontFamily: input.fontFamily, fontStyle: input.fontStyle })
    shape.resize(Number(input.width) || 200, Number(input.height) || 120)
    await place(shape, input)
    return withRamp(describe(shape), input)
  })

tool("create_text", "Create a text node (headings, prompts, instructions, labels).",
  {
    text: str(),
    fontSize: { type: ["number", "string"], description: "Default 24 (medium). Prefer textStyle (title, section, body…). Or a toolbar preset: small, medium, large, extra large, huge." },
    fontFamily: FONT_FAMILY,
    textStyle: TEXT_STYLE,
    lineHeight: num("Pixels (overrides the textStyle's)."),
    letterSpacing: num("Percent (overrides the textStyle's)."),
    fontStyle: str("Default Medium (Bold when bold is true)."),
    bold: bool(),
    italic: bool(),
    color: str("Hex (default #1E1E1E)."),
    align: str("LEFT, CENTER, RIGHT or JUSTIFIED."),
    width: num("Fixed width; text wraps and height grows."),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, ["text"],
  async function (input) {
    input = await resolveTextOptions(input, "TEXT")
    var text = figma.createText()
    await loadTextFont(text)
    text.characters = String(input.text || "")
    text.fontSize = Number(input.fontSize) || 24
    text.fills = [input.color ? solid(input.color) : { type: "SOLID", color: CHARCOAL }]
    if (input.fontFamily || input.fontStyle || input.bold || input.italic) {
      text.fontName = await loadFont(resolveFont(text.fontName, input))
    }
    if (input.__ramp || typeof input.lineHeight === "number" || typeof input.letterSpacing === "number") await styleWhole(text, rampOpts(input))
    if (input.align) text.textAlignHorizontal = oneOf(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"], input.align, "align")
    if (typeof input.width === "number") {
      text.textAutoResize = "HEIGHT"
      text.resize(input.width, text.height)
    }
    await place(text, input)
    return withRamp(describe(text), input)
  })

tool("create_label",
  "Create a small numbered/lettered circle marker (1–2 characters), e.g. step numbers or callouts. Pass targetId to pin it on a node's corner.",
  {
    text: str("1–2 characters, e.g. \"1\" or \"A\"."),
    color: str("Preset (default blue): " + Object.keys(LABEL).join(", ") + "."),
    targetId: str("Place the label on this node's corner."),
    corner: str("TOP_LEFT (default), TOP_RIGHT, BOTTOM_LEFT or BOTTOM_RIGHT."),
    textStyle: TEXT_STYLE,
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, ["text"],
  async function (input) {
    var label = figma.createShapeWithText()
    label.shapeType = "ELLIPSE"
    await loadFontFor(label)
    var chars = String(input.text || "")
    label.text.characters = chars
    var size = chars.length > 1 ? 64 : 48
    label.resize(size, size)
    label.text.fontSize = 20
    input = await resolveTextOptions(input, "SHAPE_WITH_TEXT")
    if (input.__ramp) await styleWhole(label.text, rampOpts(input))
    var preset = pick(LABEL, input.color, "blue")
    label.fills = [{ type: "SOLID", color: preset.fill }]
    label.strokes = [{ type: "SOLID", color: preset.stroke }]
    label.text.fills = [{ type: "SOLID", color: preset.text }]
    if (input.targetId) {
      var target = await getNode(input.targetId)
      var parent = target.parent && (target.parent.type === "SECTION" || target.parent.type === "GROUP") ? target.parent : activePage()
      parent.appendChild(label)
      var b = bbox(target)
      var corner = String(input.corner || "TOP_LEFT").toUpperCase()
      var ax = corner.indexOf("RIGHT") >= 0 ? b.x + b.width - size / 2 : b.x - size / 2
      var ay = corner.indexOf("BOTTOM") >= 0 ? b.y + b.height - size / 2 : b.y - size / 2
      moveAbs(label, ax, ay)
    } else await place(label, input)
    return withRamp(describe(label), input)
  })

tool("create_table",
  "Create a FigJam table. Pass rows (array of rows of cell strings) to fill it; the first row is styled as a header unless header is false.",
  {
    rows: arr(arr(str()), "Cell text, row by row."),
    numRows: int("Size of an empty table (ignored when rows is given)."),
    numColumns: int(),
    header: bool("Style the first row as a header (default true when rows has 2+ rows)."),
    headerColor: str("Table preset or hex (default black): " + Object.keys(TABLE).join(", ") + "."),
    fill: str("Table background (preset or hex)."),
    columnWidths: arr(num(), "Widths per column."),
    textStyle: str("Type ramp role for the cells (see type_ramp), e.g. body or caption."),
    headerTextStyle: str("Type ramp role for the header row (default: textStyle), e.g. label or subhead."),
    name: str(),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, [],
  async function (input) {
    var rows = Array.isArray(input.rows) ? input.rows : undefined
    var nr = rows ? rows.length : Number(input.numRows) || 2
    var nc = rows ? Math.max.apply(null, rows.map(function (r) { return Array.isArray(r) ? r.length : 1 })) : Number(input.numColumns) || 2
    if (nr < 1 || nc < 1) throw new Error("A table needs at least one row and one column.")
    if (nr * nc > 1000) throw new Error("At most 1000 cells per table.")
    var table = figma.createTable(nr, nc)
    if (input.name) table.name = String(input.name)
    if (input.fill) table.fills = [solid(input.fill, TABLE, "fill")]
    await loadTextFont(table.cellAt(0, 0).text)
    if (rows) {
      for (var r = 0; r < nr; r++) {
        for (var c = 0; c < nc; c++) {
          var value = Array.isArray(rows[r]) ? rows[r][c] : c === 0 ? rows[r] : ""
          var cellText = table.cellAt(r, c).text
          if (value !== undefined && value !== null && value !== "") {
            await loadTextFont(cellText)
            cellText.characters = String(value)
          }
        }
      }
    }
    var header = typeof input.header === "boolean" ? input.header : Boolean(rows && nr > 1)
    var tableRamp
    if (input.textStyle || input.headerTextStyle) {
      var bodyOpts = input.textStyle ? await resolveTextOptions({ textStyle: input.textStyle }, "TABLE") : undefined
      var headOpts = header && (input.headerTextStyle || input.textStyle) ? await resolveTextOptions({ textStyle: input.headerTextStyle || input.textStyle }, "TABLE") : undefined
      for (var tr = 0; tr < nr; tr++) {
        var to = tr === 0 && header ? headOpts : bodyOpts
        if (!to) continue
        for (var tc = 0; tc < nc; tc++) await styleWhole(table.cellAt(tr, tc).text, rampOpts(to))
      }
      tableRamp = {}
      if (bodyOpts) tableRamp.cells = bodyOpts.__ramp
      if (headOpts) tableRamp.header = headOpts.__ramp
    }
    if (header) styleRow(table, 0, input.headerColor || "black")
    if (Array.isArray(input.columnWidths)) {
      for (var w = 0; w < input.columnWidths.length && w < nc; w++) if (input.columnWidths[w]) table.resizeColumn(w, input.columnWidths[w])
    }
    await place(table, input)
    var td = describe(table)
    if (tableRamp) td.ramp = tableRamp
    return td
  })

function styleRow(table, row, color) {
  var paint = solid(color, TABLE, "fill")
  var preset = isHex(color) ? undefined : pick(TABLE, color)
  for (var c = 0; c < table.numColumns; c++) {
    var cell = table.cellAt(row, c)
    cell.fills = [paint]
    if (preset) cell.text.fills = [{ type: "SOLID", color: preset.text }]
  }
}

// Numeric value of a cell, or null: tolerates thousands separators, currency and %.
function cellNumber(s) {
  var t = String(s).replace(/[,\s$\u20ac\u00a3%]/g, "")
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null
  return Number(t)
}

// Indices of `values` in sorted order: numbers numerically (before text),
// text naturally, empty cells always last, stable.
function sortOrder(values, desc) {
  var idx = values.map(function (_, i) { return i })
  var sign = desc ? -1 : 1
  idx.sort(function (i, j) {
    var a = String(values[i] === undefined || values[i] === null ? "" : values[i]).trim()
    var b = String(values[j] === undefined || values[j] === null ? "" : values[j]).trim()
    if (!a || !b) return (!a && !b) ? i - j : (!a ? 1 : -1)
    var na = cellNumber(a)
    var nb = cellNumber(b)
    var cmp
    if (na !== null && nb !== null) cmp = na - nb
    else if (na !== null) cmp = -1
    else if (nb !== null) cmp = 1
    else cmp = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    return cmp ? cmp * sign : i - j
  })
  return idx
}

function sortTableRows(table, sortBy) {
  var col = Number(sortBy.col)
  if (!(col >= 0 && col < table.numColumns)) throw new Error("sortBy.col " + sortBy.col + " is outside the table (0–" + (table.numColumns - 1) + ").")
  var start = sortBy.header === false ? 0 : 1
  var vals = []
  for (var r = start; r < table.numRows; r++) vals.push(table.cellAt(r, col).text.characters)
  var order = sortOrder(vals, Boolean(sortBy.desc))
  var cur = vals.map(function (_, i) { return i })
  for (var pos = 0; pos < order.length; pos++) {
    var from = cur.indexOf(order[pos])
    if (from === pos) continue
    table.moveRow(from + start, pos + start)
    cur.splice(pos, 0, cur.splice(from, 1)[0])
  }
}

// Zero-based row/column index check; allowEnd admits numRows/numColumns (append).
function tableIndex(table, value, axis, allowEnd) {
  var n = axis === "row" ? table.numRows : table.numColumns
  var i = Number(value)
  var max = allowEnd ? n : n - 1
  if (value === undefined || value === null || value === "" || Math.floor(i) !== i || i < 0 || i > max) {
    throw toolError("bad_input", axis + " " + value + " is outside the table (0–" + max + ").")
  }
  return i
}

// Insert count rows/columns next to `at`: where above/below (rows) or left/right (columns).
function tableAdd(table, spec, axis) {
  if (typeof spec === "number") spec = { at: spec, where: axis === "row" ? "above" : "left" }
  var at = tableIndex(table, spec.at, axis)
  var where = String(spec.where || (axis === "row" ? "below" : "right")).toLowerCase()
  var ok = axis === "row" ? ["above", "below"] : ["left", "right"]
  if (ok.indexOf(where) < 0) throw toolError("bad_input", axis + " where must be " + ok.join(" or ") + ".")
  var before = where === "above" || where === "left"
  var count = clamp(spec.count, 1, 50, 1)
  for (var i = 0; i < count; i++) {
    if (axis === "row") table.insertRow(before ? at : at + 1)
    else table.insertColumn(before ? at : at + 1)
  }
}

// Delete rows/columns (an index or a list), highest first so indices stay valid.
function tableDelete(table, list, axis) {
  var n = axis === "row" ? table.numRows : table.numColumns
  var idx = []
  ;(Array.isArray(list) ? list : [list]).forEach(function (v) {
    var i = tableIndex(table, v, axis)
    if (idx.indexOf(i) < 0) idx.push(i)
  })
  if (idx.length >= n) throw toolError("bad_input", "Can't delete every " + axis + "; delete the table instead.")
  idx.sort(function (a, b) { return b - a })
  for (var k = 0; k < idx.length; k++) {
    if (axis === "row") table.removeRow(idx[k])
    else table.removeColumn(idx[k])
  }
  return idx
}

// Move one row/column: {from, to} or {from, direction: up|down|left|right, by?}.
function tableMove(table, m, axis) {
  var from = tableIndex(table, m.from, axis)
  var to = m.to
  if (m.direction) {
    var d = String(m.direction).toLowerCase()
    var sign = d === "up" || d === "left" ? -1 : d === "down" || d === "right" ? 1 : 0
    if (!sign || (axis === "row" ? (d === "left" || d === "right") : (d === "up" || d === "down"))) {
      throw toolError("bad_input", axis + " direction must be " + (axis === "row" ? "up or down" : "left or right") + ".")
    }
    to = from + sign * Math.max(1, Math.floor(Number(m.by) || 1))
    var n = axis === "row" ? table.numRows : table.numColumns
    if (to < 0 || to >= n) throw toolError("bad_input", axis + " " + from + " is already at the " + (sign < 0 ? (axis === "row" ? "top" : "left edge") : (axis === "row" ? "bottom" : "right edge")) + ".")
  }
  to = tableIndex(table, to, axis)
  if (to === from) return
  if (axis === "row") table.moveRow(from, to)
  else table.moveColumn(from, to)
}

// Structure edits in a fixed order: inserts, deletes, moves, resizes.
function tableStructure(table, input) {
  if (typeof input.insertRow === "number") table.insertRow(tableIndex(table, input.insertRow, "row", true))
  if (typeof input.insertColumn === "number") table.insertColumn(tableIndex(table, input.insertColumn, "column", true))
  if (input.addRow !== undefined) tableAdd(table, input.addRow, "row")
  if (input.addColumn !== undefined) tableAdd(table, input.addColumn, "column")
  var rows = [].concat(input.removeRow === undefined ? [] : input.removeRow, input.deleteRow === undefined ? [] : input.deleteRow)
  if (rows.length) tableDelete(table, rows, "row")
  var cols = [].concat(input.removeColumn === undefined ? [] : input.removeColumn, input.deleteColumn === undefined ? [] : input.deleteColumn)
  if (cols.length) tableDelete(table, cols, "column")
  if (input.moveRow) tableMove(table, input.moveRow, "row")
  if (input.moveColumn) tableMove(table, input.moveColumn, "column")
  if (input.resizeRow) table.resizeRow(tableIndex(table, input.resizeRow.index, "row"), input.resizeRow.height)
  if (input.resizeColumn) table.resizeColumn(tableIndex(table, input.resizeColumn.index, "column"), input.resizeColumn.width)
}

var INDEXES = { type: ["integer", "array"], items: { type: "integer" } }

tool("edit_table",
  "Change a table (FigJam's row/column menus): addRow {at, where: above|below, count?}, addColumn {at, where: left|right}, moveRow {from, to} or {from, direction: up|down}, moveColumn {from, direction: left|right}, deleteRow/deleteColumn (index or list; destructive), resize; cell text and colors, table fill, clearCell (destructive), sortBy (header kept). Merge cells is NOT possible: the plugin API has no cell-merge call. Indices are zero-based; structure changes run first (inserts, deletes, moves, resizes), then rows, cells, clearCell, sortBy, headerColor.",
  {
    id: str(),
    insertRow: int("Insert a row before this index (numRows appends)."),
    insertColumn: int("Insert a column before this index."),
    addRow: obj({ at: int("Reference row."), where: str("above or below (default below)."), count: int("Default 1.") }, "Add row above/below."),
    addColumn: obj({ at: int("Reference column."), where: str("left or right (default right)."), count: int("Default 1.") }, "Add column left/right."),
    removeRow: INDEXES,
    removeColumn: INDEXES,
    deleteRow: { type: ["integer", "array"], items: { type: "integer" }, description: "Delete row(s) (destructive)." },
    deleteColumn: { type: ["integer", "array"], items: { type: "integer" }, description: "Delete column(s) (destructive)." },
    moveRow: obj({ from: int(), to: int(), direction: str("up or down (instead of to)."), by: int("Steps for direction (default 1).") }),
    moveColumn: obj({ from: int(), to: int(), direction: str("left or right (instead of to)."), by: int() }),
    resizeRow: obj({ index: int(), height: num() }),
    resizeColumn: obj({ index: int(), width: num() }),
    rows: arr(arr(str()), "Set cell text from the top-left; grows the table if needed."),
    cells: arr(obj({ row: int(), col: int(), text: str(), fill: str("Preset or hex."), textColor: str("Hex.") }), "Per-cell edits."),
    headerColor: str("Restyle row 0 as a header with this preset or hex."),
    fill: str("Table background (preset or hex)."),
    sortBy: obj({ col: int("Zero-based column."), desc: bool("Descending (default ascending)."), header: bool("Keep row 0 in place as a header (default true).") }, "Sort rows by a column's text: numbers compare numerically (1,234 / $5 / 40%), other text naturally (item2 < item10), empty cells last. Rows move whole (cell colors go with them)."),
    clearCell: arr(obj({ row: int(), col: int() }), "Delete the content of these cells (destructive: needs expect or confirm)."),
  }, ["id"],
  async function (input) {
    var table = await getNode(input.id)
    if (table.type !== "TABLE") throw new Error("Node " + input.id + " is a " + table.type + ", not a TABLE.")
    tableStructure(table, input)
    if (input.fill) table.fills = [solid(input.fill, TABLE, "fill")]
    if (Array.isArray(input.rows)) {
      for (var r = 0; r < input.rows.length; r++) {
        while (table.numRows <= r) table.insertRow(table.numRows)
        var row = Array.isArray(input.rows[r]) ? input.rows[r] : [input.rows[r]]
        for (var c = 0; c < row.length; c++) {
          while (table.numColumns <= c) table.insertColumn(table.numColumns)
          var t = table.cellAt(r, c).text
          await loadTextFont(t)
          t.characters = String(row[c] === undefined || row[c] === null ? "" : row[c])
        }
      }
    }
    if (Array.isArray(input.cells)) {
      for (var i = 0; i < input.cells.length; i++) {
        var e = input.cells[i]
        if (e.row >= table.numRows || e.col >= table.numColumns) throw new Error("No cell at row " + e.row + ", col " + e.col + ".")
        var cell = table.cellAt(e.row, e.col)
        if (typeof e.text === "string") {
          await loadTextFont(cell.text)
          cell.text.characters = e.text
        }
        if (e.fill) {
          cell.fills = [solid(e.fill, TABLE, "fill")]
          if (!e.textColor && !isHex(e.fill)) {
            await loadTextFont(cell.text)
            cell.text.fills = [{ type: "SOLID", color: pick(TABLE, e.fill).text }]
          }
        }
        if (e.textColor) {
          await loadTextFont(cell.text)
          cell.text.fills = [solid(e.textColor)]
        }
      }
    }
    if (Array.isArray(input.clearCell)) {
      for (var cc = 0; cc < input.clearCell.length; cc++) {
        var ce = input.clearCell[cc]
        if (!(ce.row < table.numRows && ce.col < table.numColumns)) throw new Error("No cell at row " + ce.row + ", col " + ce.col + ".")
        var ct = table.cellAt(ce.row, ce.col).text
        await loadTextFont(ct)
        ct.characters = ""
      }
    }
    if (input.sortBy) sortTableRows(table, input.sortBy)
    if (input.headerColor) {
      for (var hc = 0; hc < table.numColumns; hc++) await loadTextFont(table.cellAt(0, hc).text)
      styleRow(table, 0, input.headerColor)
    }
    return detail(table, 0)
  })

async function setCode(block, code, language) {
  if (language) block.codeLanguage = oneOf(LANGUAGES, language, "language")
  if (typeof code === "string") {
    // FigJam renders code in Source Code Pro Medium and won't take text until it's loaded.
    try {
      await figma.loadFontAsync(CODE_FONT)
    } catch (error) {
      // Try anyway; the error below is clearer if it still fails.
    }
    block.code = code
  }
}

// ------------------------------------------------------------------ mind maps

var MIND_COLORS = ["blue", "green", "violet", "orange", "pink", "teal", "red", "yellow"]
var MIND_GAP_X = 96
var MIND_GAP_Y = 24
var MIND_MAX = 200

function mindSize(text, depth) {
  var fs = depth === 0 ? 22 : depth === 1 ? 18 : 16
  var len = Math.max(1, String(text || "").length)
  var minW = depth === 0 ? 180 : 120
  var maxW = depth === 0 ? 320 : 260
  var w = Math.min(maxW, Math.max(minW, Math.round(len * fs * 0.55) + 48))
  var lines = Math.max(1, Math.ceil(len * fs * 0.55 / (w - 48)))
  var h = Math.max(depth === 0 ? 80 : 56, Math.round(lines * fs * 1.4) + 28)
  return { w: w, h: h, fontSize: fs }
}

// Lay out a tree {text, children} as a mind map. Pure: returns items
// [{text, depth, branch, side, parent, x, y, w, h, fontSize}] with the root at
// index 0 and its top-left at (0, 0); parent is an index. layout: right | both | radial.
function mindMapLayout(root, layout) {
  layout = String(layout || "right").toLowerCase()
  if (["right", "both", "radial"].indexOf(layout) < 0) throw toolError("bad_input", "layout must be right, both or radial.")
  var items = []
  function add(n, depth, parent, branch) {
    if (items.length >= MIND_MAX) throw toolError("bad_input", "At most " + MIND_MAX + " mind map nodes per call.")
    var text = typeof n === "string" ? n : String((n && n.text) || "")
    var sz = mindSize(text, depth)
    var it = { text: text, depth: depth, parent: parent, branch: branch, w: sz.w, h: sz.h, fontSize: sz.fontSize, kids: [] }
    var idx = items.length
    items.push(it)
    var kids = n && typeof n === "object" && Array.isArray(n.children) ? n.children : []
    for (var i = 0; i < kids.length; i++) it.kids.push(add(kids[i], depth + 1, idx, depth === 0 ? i : branch))
    return idx
  }
  add(root, 0, -1, -1)
  var r = items[0]
  r.x = 0
  r.y = 0
  r.side = 0
  if (layout === "radial") radialLayout(items)
  else {
    var right = r.kids.slice()
    var left = []
    if (layout === "both" && r.kids.length > 1) {
      right = []
      var hr = 0
      var hl = 0
      var order = r.kids.slice().sort(function (a, b) { return blockHeight(items, b) - blockHeight(items, a) || a - b })
      order.forEach(function (k) {
        var bh = blockHeight(items, k)
        if (hr <= hl) { right.push(k); hr += bh + MIND_GAP_Y } else { left.push(k); hl += bh + MIND_GAP_Y }
      })
      right.sort(function (a, b) { return a - b })
      left.sort(function (a, b) { return a - b })
    }
    sideLayout(items, right, 1)
    sideLayout(items, left, -1)
  }
  items.forEach(function (it) { delete it.kids; it.x = Math.round(it.x); it.y = Math.round(it.y) })
  return items
}

function blockHeight(items, i) {
  var it = items[i]
  if (it.block !== undefined) return it.block
  var sum = 0
  for (var k = 0; k < it.kids.length; k++) sum += blockHeight(items, it.kids[k]) + (k ? MIND_GAP_Y : 0)
  it.block = Math.max(it.h, sum)
  return it.block
}

// One side of a horizontal tree: columns per depth, each subtree in its own band.
function sideLayout(items, tops, dir) {
  if (!tops.length) return
  var r = items[0]
  var colW = {}
  function widths(i) {
    var it = items[i]
    colW[it.depth] = Math.max(colW[it.depth] || 0, it.w)
    it.kids.forEach(widths)
  }
  tops.forEach(widths)
  var edge = {} // depth -> x of the column's inner edge (left edge on the right side, right edge on the left)
  edge[1] = dir > 0 ? r.w + MIND_GAP_X : -MIND_GAP_X
  for (var d = 2; colW[d] !== undefined; d++) edge[d] = edge[d - 1] + dir * (colW[d - 1] + MIND_GAP_X)
  var total = 0
  tops.forEach(function (k, n) { total += blockHeight(items, k) + (n ? MIND_GAP_Y : 0) })
  var y = r.h / 2 - total / 2
  function place(i, top) {
    var it = items[i]
    var bh = blockHeight(items, i)
    it.side = dir
    it.x = dir > 0 ? edge[it.depth] : edge[it.depth] - it.w
    it.y = top + bh / 2 - it.h / 2
    var sum = 0
    it.kids.forEach(function (k, n) { sum += blockHeight(items, k) + (n ? MIND_GAP_Y : 0) })
    var ky = top + bh / 2 - sum / 2
    it.kids.forEach(function (k) {
      place(k, ky)
      ky += blockHeight(items, k) + MIND_GAP_Y
    })
  }
  tops.forEach(function (k) {
    place(k, y)
    y += blockHeight(items, k) + MIND_GAP_Y
  })
}

// Radial: each subtree gets an angle range by leaf count; rings are spaced so
// neighbors on a ring and adjacent rings can't touch (bounding circles).
function radialLayout(items) {
  function leaves(i) {
    var it = items[i]
    if (it.leaves) return it.leaves
    it.leaves = it.kids.length ? it.kids.reduce(function (s, k) { return s + leaves(k) }, 0) : 1
    return it.leaves
  }
  var r = items[0]
  if (!r.kids.length) return
  function assign(i, a0, a1) {
    var it = items[i]
    it.angle = (a0 + a1) / 2
    var total = leaves(i)
    var a = a0
    it.kids.forEach(function (k) {
      var span = (a1 - a0) * leaves(k) / total
      assign(k, a, a + span)
      a += span
    })
  }
  assign(0, -Math.PI, Math.PI)
  var byDepth = {}
  var maxDepth = 0
  items.forEach(function (it, i) {
    if (!i) return
    ;(byDepth[it.depth] = byDepth[it.depth] || []).push(it)
    maxDepth = Math.max(maxDepth, it.depth)
  })
  function diag(it) { return Math.sqrt(it.w * it.w + it.h * it.h) }
  var prevR = 0
  var prevD = diag(r)
  var cx = r.w / 2
  var cy = r.h / 2
  for (var d = 1; d <= maxDepth; d++) {
    var ring = byDepth[d].slice().sort(function (a, b) { return a.angle - b.angle })
    var maxD = Math.max.apply(null, ring.map(diag))
    var R = prevR + prevD / 2 + maxD / 2 + MIND_GAP_Y * 2
    for (var j = 0; ring.length > 1 && j < ring.length; j++) {
      var a = ring[j]
      var b = ring[(j + 1) % ring.length]
      var delta = b.angle - a.angle
      if (delta <= 0) delta += 2 * Math.PI
      delta = Math.min(delta, Math.PI)
      var need = ((diag(a) + diag(b)) / 2 + MIND_GAP_Y) / (2 * Math.sin(delta / 2))
      R = Math.max(R, need)
    }
    ring.forEach(function (it) {
      it.side = Math.cos(it.angle) >= 0 ? 1 : -1
      it.x = cx + R * Math.cos(it.angle) - it.w / 2
      it.y = cy + R * Math.sin(it.angle) - it.h / 2
    })
    prevR = R
    prevD = maxD
  }
}

// Root charcoal; topics in the branch hue; deeper levels in its light tint.
function mindPreset(depth, hue) {
  if (depth === 0) return SHAPE.black
  if (isHex(hue)) {
    var c = parseHex(hue).color
    return { fill: depth === 1 ? c : WHITE, stroke: c, text: depth === 1 && luminance(c) < 0.4 ? WHITE : CHARCOAL }
  }
  var tint = findKey(SHAPE, "light" + hue)
  return depth === 1 || !tint ? pick(SHAPE, hue) : SHAPE[tint]
}

tool("create_mind_map",
  "Create a mind map (FigJam's Start a mind map): a root topic with nested branches as rounded shapes joined by curved connectors, balanced layout and consistent spacing, each top-level branch in its own color (saturated topic, light tints below). layout: right (default, tree to the right), both (branches split left/right, balanced) or radial (around the root). Up to 200 nodes. Pass clientId so a retry doesn't duplicate it.",
  {
    root: obj({ text: str(), children: arr({ type: "object", description: "{text, children: [...]} (recursive) or a string." }) }, "The root topic: {text, children: [{text, children}]}."),
    layout: str("right (default), both or radial."),
    colors: arr(str(), "Branch colors in order (default blue, green, violet, orange, pink, teal, red, yellow)."),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, ["root"],
  async function (input) {
    if (!input.root || (typeof input.root !== "string" && !String(input.root.text || "").trim())) throw toolError("bad_input", "root needs text.")
    var items = mindMapLayout(input.root, input.layout)
    var colors = Array.isArray(input.colors) && input.colors.length ? input.colors : MIND_COLORS
    var box = { x: 0, y: 0, x2: 0, y2: 0 }
    items.forEach(function (it) {
      box.x = Math.min(box.x, it.x)
      box.y = Math.min(box.y, it.y)
      box.x2 = Math.max(box.x2, it.x + it.w)
      box.y2 = Math.max(box.y2, it.y + it.h)
    })
    var section
    var origin
    if (input.sectionId) {
      section = await getSection(input.sectionId)
      var bottom = PAD
      for (var c = 0; c < section.children.length; c++) bottom = Math.max(bottom, section.children[c].y + section.children[c].height + GAP)
      origin = { x: typeof input.x === "number" ? input.x : PAD, y: typeof input.y === "number" ? input.y : bottom }
    } else origin = typeof input.x === "number" && typeof input.y === "number" ? { x: input.x, y: input.y } : freeSpot()
    var parent = section || activePage()
    var nodes = []
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      var shape = figma.createShapeWithText()
      shape.shapeType = "ROUNDED_RECTANGLE"
      parent.appendChild(shape)
      await loadFontFor(shape)
      shape.text.characters = it.text
      shape.text.fontSize = it.fontSize
      var hue = it.branch < 0 ? undefined : colors[it.branch % colors.length]
      var preset = mindPreset(it.depth, hue)
      shape.fills = [{ type: "SOLID", color: preset.fill }]
      shape.strokes = [{ type: "SOLID", color: preset.stroke }]
      shape.text.fills = [{ type: "SOLID", color: preset.text }]
      shape.resize(it.w, it.h)
      shape.x = origin.x + it.x - box.x
      shape.y = origin.y + it.y - box.y
      shape.name = it.text.slice(0, 60) || "Topic"
      nodes.push(shape)
    }
    var connectors = []
    for (var k = 1; k < items.length; k++) {
      var item = items[k]
      var conn = figma.createConnector()
      parent.appendChild(conn)
      var side = input.layout && String(input.layout).toLowerCase() === "radial" ? "AUTO" : null
      conn.connectorStart = { endpointNodeId: nodes[item.parent].id, magnet: side || (item.side < 0 ? "LEFT" : "RIGHT") }
      conn.connectorEnd = { endpointNodeId: nodes[k].id, magnet: side || (item.side < 0 ? "RIGHT" : "LEFT") }
      conn.connectorLineType = "CURVED"
      conn.connectorStartStrokeCap = "NONE"
      conn.connectorEndStrokeCap = "NONE"
      var branchHue = colors[item.branch % colors.length]
      conn.strokes = [solid(branchHue, CONNECTOR)]
      conn.strokeWeight = item.depth === 1 ? 4 : 3
      connectors.push(conn.id)
    }
    if (section) fitSection(section)
    return { id: nodes[0].id, rootId: nodes[0].id, created: nodes.map(describe), connectorIds: connectors, layout: String(input.layout || "right").toLowerCase() }
  })

tool("create_code_block", "Create a code block with syntax highlighting.",
  {
    code: str(),
    language: str(LANGUAGES.join(", ") + " (default PLAINTEXT)."),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, ["code"],
  async function (input) {
    var block = figma.createCodeBlock()
    await setCode(block, String(input.code || ""), input.language || "PLAINTEXT")
    await place(block, input)
    return describe(block)
  })

tool("create_link",
  "Create a link preview (unfurled card, or an embed for supported providers like YouTube/Figma) from a URL.",
  { url: str(), sectionId: SECTION_ID, x: X, y: Y }, ["url"],
  async function (input) {
    if (typeof figma.createLinkPreviewAsync !== "function") throw new Error("This Figma version has no createLinkPreviewAsync.")
    var node = await figma.createLinkPreviewAsync(String(input.url))
    await place(node, input)
    return describe(node)
  })

// Ask the panel (iframe) to fetch bytes. Only works for hosts the manifest's
// networkAccess allows, so the bridge normally fetches URLs itself.
var pendingFetches = {}
var fetchSeq = 0

function uiFetch(url) {
  return new Promise(function (resolve, reject) {
    var id = "f" + (++fetchSeq)
    var timer = setTimeout(function () {
      delete pendingFetches[id]
      reject(new Error("The panel didn't fetch " + url + " within 20s."))
    }, 20000)
    pendingFetches[id] = { resolve: resolve, reject: reject, timer: timer }
    figma.ui.postMessage({ type: "fetch", id: id, url: url })
  })
}

async function imageFromInput(input) {
  if (input.base64) {
    var bytes = base64ToBytes(input.base64)
    return { image: figma.createImage(bytes), bytes: bytes }
  }
  if (!input.url) throw new Error("Pass base64 (image bytes) or url.")
  var url = String(input.url)
  var errors = []
  if (typeof figma.createImageAsync === "function") {
    try {
      return { image: await figma.createImageAsync(url) }
    } catch (error) {
      errors.push("createImageAsync: " + errorText(error))
    }
  }
  try {
    var fetched = await uiFetch(url)
    return { image: figma.createImage(fetched), bytes: fetched }
  } catch (error) {
    errors.push("panel fetch: " + errorText(error))
  }
  throw new Error("Couldn't load " + url + " (" + errors.join("; ") + "). Pass base64 instead; the bridge does this for you when you call it with url.")
}

function isGif(bytes) {
  return bytes && bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
}

tool("create_image",
  "Place an image (PNG/JPG/GIF) on the board as a rectangle with an image fill (animated GIFs become media). Pass base64 bytes, or url (the bridge fetches it; in the panel only allowed hosts work).",
  {
    base64: str("Image bytes, base64 (a data: URL prefix is fine)."),
    url: str(),
    name: str(),
    width: num("Default: natural size, scaled to fit maxSize."),
    height: num(),
    maxSize: num("Longest side when width/height are omitted (default 800)."),
    scaleMode: str("FILL (default), FIT, CROP or TILE."),
    cornerRadius: num(),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, [],
  async function (input) {
    var loaded = await imageFromInput(input)
    var size = { width: 400, height: 300 }
    try {
      size = await loaded.image.getSizeAsync()
    } catch (error) {
      // Keep the default size.
    }
    var w = Number(input.width)
    var hh = Number(input.height)
    if (!w && !hh) {
      var max = Number(input.maxSize) || 800
      var k = Math.min(1, max / Math.max(size.width, size.height))
      w = size.width * k
      hh = size.height * k
    } else if (!w) w = hh * size.width / size.height
    else if (!hh) hh = w * size.height / size.width
    var node
    if (isGif(loaded.bytes) && typeof figma.createGif === "function") {
      node = figma.createGif(loaded.image.hash)
      node.resize(w, hh)
    } else {
      node = figma.createRectangle()
      node.resize(w, hh)
      node.fills = [{ type: "IMAGE", imageHash: loaded.image.hash, scaleMode: String(input.scaleMode || "FILL").toUpperCase() }]
      if (typeof input.cornerRadius === "number") node.cornerRadius = input.cornerRadius
    }
    node.name = String(input.name || "Image")
    await place(node, input)
    var d = describe(node)
    d.imageHash = loaded.image.hash
    d.naturalSize = size
    return d
  })

var MAGNETS = ["AUTO", "TOP", "BOTTOM", "LEFT", "RIGHT", "CENTER", "NONE"]

function magnet(value) {
  return oneOf(MAGNETS, value || "AUTO", "magnet")
}

// An endpoint attached to a node side, or a fixed point on the page.
async function endpoint(id, point, side) {
  if (point && typeof point.x === "number" && typeof point.y === "number") return { position: { x: point.x, y: point.y } }
  if (!id) throw new Error("Each end needs a node id or a point {x, y}.")
  var node = await getNode(id)
  return { endpointNodeId: node.id, magnet: magnet(side) }
}

// The new value for one end of an existing connector: a new node or point
// wins; a magnet alone re-sides the current node. Free ends stay free.
async function changeEnd(current, id, point, side) {
  if (point && typeof point.x === "number") return endpoint(undefined, point)
  if (id) return endpoint(id, undefined, side || (!isFloating(current) && current.magnet) || "AUTO")
  if (isFloating(current)) {
    if (side) throw new Error("That end of the connector isn't attached to a node; pass fromId/toId with the magnet.")
    return { position: current.position }
  }
  return endpoint(current.endpointNodeId, undefined, side)
}

var LINE_TYPES = ["ELBOWED", "STRAIGHT", "CURVED"]

// Straight connectors only accept CENTER/NONE magnets; map side magnets to
// CENTER so a straight line still attaches (it points at the node's center).
function forStraight(end) {
  if (end && end.endpointNodeId && end.magnet && end.magnet !== "CENTER" && end.magnet !== "NONE") {
    return { endpointNodeId: end.endpointNodeId, magnet: "CENTER" }
  }
  return end
}

function applyConnectorStyle(connector, input) {
  if (input.lineType) connector.connectorLineType = oneOf(["ELBOWED", "STRAIGHT", "CURVED"], input.lineType, "lineType")
  if (typeof input.arrow === "boolean") connector.connectorEndStrokeCap = input.arrow ? "ARROW_LINES" : "NONE"
  if (input.startCap) connector.connectorStartStrokeCap = oneOf(CAPS, input.startCap, "cap")
  if (input.endCap) connector.connectorEndStrokeCap = oneOf(CAPS, input.endCap, "cap")
  if (input.color) connector.strokes = [solid(input.color, CONNECTOR)]
  if (input.stroke) connector.strokes = [solid(input.stroke, CONNECTOR)]
  if (typeof input.strokeWeight === "number") connector.strokeWeight = input.strokeWeight
  if (Array.isArray(input.dashPattern)) connector.dashPattern = input.dashPattern
}

// ---- connector routing (pure helpers; boxes are {x, y, width, height})

// Pick facing sides from two boxes. The axis with the larger clear gap wins;
// if the boxes overlap on one axis, route along the other; if they overlap on
// both, the larger center offset decides.
function pickMagnets(a, b) {
  var acx = a.x + a.width / 2
  var acy = a.y + a.height / 2
  var bcx = b.x + b.width / 2
  var bcy = b.y + b.height / 2
  var gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
  var gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
  var horizontal
  if (gapX >= 0 && gapY < 0) horizontal = true
  else if (gapY >= 0 && gapX < 0) horizontal = false
  else if (gapX >= 0 && gapY >= 0) horizontal = gapX >= gapY
  else horizontal = Math.abs(bcx - acx) >= Math.abs(bcy - acy)
  if (horizontal) {
    var right = bcx >= acx
    return { start: right ? "RIGHT" : "LEFT", end: right ? "LEFT" : "RIGHT", axis: "x", aligned: Math.abs(acy - bcy) <= 4 }
  }
  var down = bcy >= acy
  return { start: down ? "BOTTOM" : "TOP", end: down ? "TOP" : "BOTTOM", axis: "y", aligned: Math.abs(acx - bcx) <= 4 }
}

function facing(s, e) {
  return (s === "RIGHT" && e === "LEFT") || (s === "LEFT" && e === "RIGHT") || (s === "TOP" && e === "BOTTOM") || (s === "BOTTOM" && e === "TOP")
}

// Resolve one connection spec into endpoints + line type.
async function routeConnection(c) {
  var start = await endpoint(c.fromId || c.from, c.fromPoint, c.startMagnet)
  var end = await endpoint(c.toId || c.to, c.toPoint, c.endMagnet)
  var picked
  if (start.endpointNodeId && end.endpointNodeId && (!c.startMagnet || !c.endMagnet)) {
    picked = pickMagnets(bbox(await getNode(start.endpointNodeId)), bbox(await getNode(end.endpointNodeId)))
    if (!c.startMagnet) start.magnet = picked.start
    if (!c.endMagnet) end.magnet = picked.end
  }
  var lineType
  if (c.lineType) lineType = oneOf(LINE_TYPES, c.lineType, "lineType")
  else if (picked && picked.aligned && facing(start.magnet, end.magnet)) lineType = "STRAIGHT"
  else lineType = "ELBOWED"
  return { start: start, end: end, lineType: lineType }
}

async function makeConnector(c, shared) {
  var spec = {}
  var k
  for (k in shared) if (k !== "connections") spec[k] = shared[k]
  for (k in c) spec[k] = c[k]
  var r = await routeConnection(spec)
  var connector = figma.createConnector()
  if (connector.parent !== activePage()) activePage().appendChild(connector)
  // Set the line type before the ends: a new connector starts STRAIGHT,
  // which rejects side magnets (TOP/BOTTOM/LEFT/RIGHT).
  connector.connectorLineType = r.lineType
  connector.connectorStart = r.lineType === "STRAIGHT" ? forStraight(r.start) : r.start
  connector.connectorEnd = r.lineType === "STRAIGHT" ? forStraight(r.end) : r.end
  connector.connectorStartStrokeCap = "NONE"
  connector.connectorEndStrokeCap = spec.arrow === false ? "NONE" : "ARROW_LINES"
  connector.strokes = [solid(spec.color || "gray", CONNECTOR)]
  applyConnectorStyle(connector, { startCap: spec.startCap, endCap: spec.endCap, strokeWeight: spec.strokeWeight, dashPattern: spec.dashPattern })
  var label = spec.label !== undefined ? spec.label : spec.text
  if (label) {
    await loadTextFont(connector.text)
    connector.text.characters = String(label)
  }
  return connector
}

var CONNECTOR_PROPS = {
  fromId: str(),
  toId: str(),
  startMagnet: str(MAGNET_DESC + " Omit to auto-pick the facing side from the nodes' positions."),
  endMagnet: str(MAGNET_DESC + " Omit to auto-pick."),
  fromPoint: obj(POINT, "Start at this page point {x, y} instead of a node."),
  toPoint: obj(POINT, "End at this page point {x, y} instead of a node."),
  label: str("Text on the connector (e.g. \"yes\", \"no\", \"calls\"). Alias: text."),
  text: str("Same as label."),
  lineType: str("ELBOWED, STRAIGHT or CURVED. Default: STRAIGHT when the auto-picked sides face each other and are aligned within 4px, else ELBOWED."),
  color: str("Connector color name (default gray) or hex."),
  arrow: bool("Arrowhead at the end (default true). Shorthand for endCap ARROW_LINES/NONE."),
  startCap: str("Start cap: " + CAP_DESC),
  endCap: str("End cap (overrides arrow): " + CAP_DESC),
  strokeWeight: num(),
  dashPattern: arr(num(), "e.g. [10, 6] for dashed; [] for solid."),
}
var CONNECTION_ITEM = {
  from: str("Start node id (alias fromId)."),
  to: str("End node id (alias toId)."),
  label: str(),
  startMagnet: str(),
  endMagnet: str(),
  lineType: str(),
  color: str(),
  arrow: bool(),
  dashPattern: arr(num()),
}
var CONNECT_PROPS = {}
Object.keys(CONNECTOR_PROPS).forEach(function (k) { CONNECT_PROPS[k] = CONNECTOR_PROPS[k] })
CONNECT_PROPS.connections = arr(obj(CONNECTION_ITEM), "Many connectors in one call: [{from, to, label?, ...}]. Top-level style fields are the defaults for each.")

tool("connect",
  "Draw connectors (arrows) between nodes, or between fixed page points. For flows and diagrams: lay shapes out on a grid with clear gaps, then connect them, ideally all edges in one call via connections [{from, to, label}]. Routing: with magnets omitted, sides are picked from the two nodes' bounding boxes along the dominant axis (side by side → RIGHT→LEFT, stacked → BOTTOM→TOP; if the boxes overlap on one axis the other is used). Line type defaults to ELBOWED (clean right angles), or STRAIGHT when the facing sides are aligned; pass CURVED for organic maps. Label edges (\"yes\"/\"no\", verbs). Waypoints/bends can't be set through the API, so lay nodes out to avoid crossings.",
  CONNECT_PROPS, [],
  async function (input) {
    if (Array.isArray(input.connections) && input.connections.length) {
      if (input.connections.length > 100) throw new Error("At most 100 connections per call.")
      var made = []
      for (var i = 0; i < input.connections.length; i++) made.push(describe(await makeConnector(input.connections[i] || {}, input)))
      return { created: made }
    }
    return describe(await makeConnector({}, input))
  })

// ------------------------------------------------------------------ tools: pen, stamps, links

// Catmull-Rom through the points → cubic Bézier path data (Figma vector
// path syntax: M/L/C/Z with space-separated numbers). Points are [x, y].
function strokePath(points, smooth, closed) {
  function f(v) { return String(Math.round(v * 100) / 100) }
  var n = points.length
  if (n === 0) return ""
  var d = ["M", f(points[0][0]), f(points[0][1])]
  if (n === 1) {
    d.push("L", f(points[0][0] + 0.01), f(points[0][1]))
    return d.join(" ")
  }
  if (!smooth || n === 2) {
    for (var i = 1; i < n; i++) d.push("L", f(points[i][0]), f(points[i][1]))
    if (closed) d.push("Z")
    return d.join(" ")
  }
  function at(k) {
    if (closed) return points[(k + n) % n]
    return points[Math.max(0, Math.min(n - 1, k))]
  }
  var segments = closed ? n : n - 1
  for (var s = 0; s < segments; s++) {
    var p0 = at(s - 1)
    var p1 = at(s)
    var p2 = at(s + 1)
    var p3 = at(s + 2)
    d.push("C",
      f(p1[0] + (p2[0] - p0[0]) / 6), f(p1[1] + (p2[1] - p0[1]) / 6),
      f(p2[0] - (p3[0] - p1[0]) / 6), f(p2[1] - (p3[1] - p1[1]) / 6),
      f(p2[0]), f(p2[1]))
  }
  if (closed) d.push("Z")
  return d.join(" ")
}

var STROKE_ITEM = {
  points: arr(arr(num()), "[[x, y], ...] in page coordinates (section-relative with sectionId). 2+ points."),
  smooth: bool("Smooth curve through the points (default true); false = straight segments."),
  color: str("Connector palette name (black, gray, green, teal, blue, violet, pink, red, orange, yellow) or hex."),
  width: num("Stroke width (default 4 pen, 20 highlighter)."),
  opacity: num("0–1 (default 1 pen, 0.4 highlighter)."),
  closed: bool("Close the path (e.g. a circle around something)."),
}

tool("draw",
  "Draw freehand marker strokes (pen) or highlighter strokes, as vectors with round caps/joins. Use to annotate: circle a cluster (closed loop of ~8–12 points around its bounding box), underline a heading, draw an arrow-ish squiggle, or highlight across text. style \"highlighter\" = wide, translucent, yellow by default. Points are smoothed with Catmull-Rom curves. Returns the new vector ids. (These are vector nodes, not FigJam's native pen strokes.)",
  {
    strokes: arr(obj(STROKE_ITEM), "Strokes to draw."),
    style: str("pen (default) or highlighter."),
    color: str("Default color for strokes without one (pen: black, highlighter: yellow)."),
    sectionId: str("Put the strokes in this section (points then section-relative)."),
    name: str("Layer name (default Pen / Highlighter)."),
  }, ["strokes"],
  async function (input) {
    var strokes = input.strokes
    if (!Array.isArray(strokes) || strokes.length === 0) throw new Error("strokes must be a non-empty list.")
    if (strokes.length > 50) throw new Error("At most 50 strokes per call.")
    var highlighter = String(input.style || "pen").toLowerCase() === "highlighter"
    var section = input.sectionId ? await getSection(input.sectionId) : undefined
    var made = []
    for (var i = 0; i < strokes.length; i++) {
      var st = strokes[i] || {}
      var pts = (st.points || []).filter(function (p) { return Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" })
      if (pts.length < 2) throw new Error("Stroke " + i + " needs at least 2 [x, y] points.")
      var minX = Infinity
      var minY = Infinity
      for (var k = 0; k < pts.length; k++) {
        minX = Math.min(minX, pts[k][0])
        minY = Math.min(minY, pts[k][1])
      }
      var local = pts.map(function (p) { return [p[0] - minX, p[1] - minY] })
      var vector = figma.createVector()
      if (section) section.appendChild(vector)
      else if (vector.parent !== activePage()) activePage().appendChild(vector)
      vector.vectorPaths = [{ windingRule: "NONE", data: strokePath(local, st.smooth !== false, !!st.closed) }]
      vector.fills = []
      vector.strokes = [solid(st.color || input.color || (highlighter ? "yellow" : "black"), CONNECTOR)]
      vector.strokeWeight = clamp(st.width, 0.5, 200, highlighter ? 20 : 4)
      if (highlighter && vector.strokeWeight < 16) vector.strokeWeight = 16
      vector.strokeCap = "ROUND"
      vector.strokeJoin = "ROUND"
      vector.opacity = clamp(st.opacity, 0.05, 1, highlighter ? 0.4 : 1)
      if (highlighter) vector.opacity = Math.max(0.35, Math.min(0.5, vector.opacity))
      vector.name = input.name || (highlighter ? "Highlighter" : "Pen")
      vector.x = minX
      vector.y = minY
      made.push(vector)
    }
    if (section) fitSection(section)
    return { ids: made.map(function (n) { return n.id }), created: made.map(describe) }
  })

// Stamp names → aliases and the emoji used when no real stamp is available.
var STAMPS = [
  { key: "thumbs up", emoji: "👍", aliases: ["thumbs up", "thumbsup", "thumbs-up", "+1", "plus one", "plus1", "like", "yes", "agree"] },
  { key: "thumbs down", emoji: "👎", aliases: ["thumbs down", "thumbsdown", "-1", "dislike", "no"] },
  { key: "heart", emoji: "❤️", aliases: ["heart", "love"] },
  { key: "star", emoji: "⭐", aliases: ["star", "favorite"] },
  { key: "question", emoji: "❓", aliases: ["question", "question mark", "?"] },
  { key: "check", emoji: "✅", aliases: ["check", "checkmark", "tick", "done"] },
  { key: "eyes", emoji: "👀", aliases: ["eyes", "look"] },
  { key: "fire", emoji: "🔥", aliases: ["fire", "hot"] },
  { key: "100", emoji: "💯", aliases: ["100", "hundred"] },
  { key: "party", emoji: "🎉", aliases: ["party", "tada", "celebrate"] },
]

function stampKind(name) {
  var want = String(name || "thumbs up").toLowerCase().trim()
  for (var i = 0; i < STAMPS.length; i++) if (STAMPS[i].aliases.indexOf(want) >= 0) return STAMPS[i]
  return { key: want, emoji: Array.from(want).length <= 2 ? want : undefined, aliases: [want] }
}

async function findStamp(kind) {
  function match(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = String(nodes[i].name || "").toLowerCase()
      for (var a = 0; a < kind.aliases.length; a++) if (n.indexOf(kind.aliases[a]) >= 0) return nodes[i]
    }
    return undefined
  }
  var found = match(activePage().findAllWithCriteria({ types: ["STAMP"] }))
  if (found) return found
  var pages = figma.root.children
  for (var p = 0; p < pages.length; p++) {
    if (pages[p] === activePage()) continue
    try {
      await pages[p].loadAsync()
      found = match(pages[p].findAllWithCriteria({ types: ["STAMP"] }))
      if (found) return found
    } catch (error) {
      // Page couldn't load; skip it.
    }
  }
  return undefined
}

tool("stamp",
  "Put a reaction/vote stamp on a node (thumbs up/+1, thumbs down, heart, star, question, check, eyes, fire, 100, party) — use to vote, react, or mark decisions. LIMITATION: the Plugin API can't create native FigJam stamps. If the board already has a stamp of that kind (any page), it is cloned; otherwise an emoji stand-in is made (a white circle with the emoji, or plain emoji text) and the result says so. Pin to a node's corner with targetId (like create_label), or place with x/y.",
  {
    kind: str("Stamp name, e.g. thumbs up, +1, heart, star, question, check, eyes, fire, 100, or a single emoji."),
    targetId: str("Pin onto this node's corner."),
    targetIds: arr(str(), "Stamp several nodes at once (e.g. votes)."),
    corner: str("TOP_RIGHT (default), TOP_LEFT, BOTTOM_LEFT or BOTTOM_RIGHT."),
    circle: bool("Emoji fallback: on a white circle (default true)."),
    size: num("Emoji fallback size (default 56)."),
    sectionId: SECTION_ID,
    x: X,
    y: Y,
  }, [],
  async function (input) {
    var kind = stampKind(input.kind)
    var source = await findStamp(kind)
    if (!source && !kind.emoji) throw new Error("No stamp \"" + input.kind + "\" on this board and no emoji for it. Use one of: " + STAMPS.map(function (s) { return s.key }).join(", ") + ", or pass an emoji.")
    var targets = Array.isArray(input.targetIds) && input.targetIds.length ? input.targetIds : input.targetId ? [input.targetId] : [null]
    if (targets.length > 50) throw new Error("At most 50 targets per call.")
    var size = clamp(input.size, 24, 400, 56)
    var made = []
    for (var i = 0; i < targets.length; i++) {
      var node
      if (source) {
        node = source.clone()
      } else if (input.circle === false) {
        node = figma.createText()
        await loadTextFont(node)
        node.characters = kind.emoji
        node.fontSize = Math.round(size * 0.8)
      } else {
        node = figma.createShapeWithText()
        node.shapeType = "ELLIPSE"
        await loadFontFor(node)
        node.text.characters = kind.emoji
        node.resize(size, size)
        node.text.fontSize = Math.round(size * 0.5)
        node.fills = [{ type: "SOLID", color: WHITE }]
        node.strokes = [{ type: "SOLID", color: h(0xb3, 0xb3, 0xb3) }]
      }
      if (!source) node.name = "Stamp: " + kind.key
      if (targets[i]) {
        var target = await getNode(targets[i])
        var parent = target.parent && (target.parent.type === "SECTION" || target.parent.type === "GROUP") ? target.parent : activePage()
        parent.appendChild(node)
        var b = bbox(target)
        var corner = String(input.corner || "TOP_RIGHT").toUpperCase()
        var w = node.width
        var hh = node.height
        var ax = corner.indexOf("LEFT") >= 0 ? b.x - w / 3 : b.x + b.width - (2 * w) / 3
        var ay = corner.indexOf("BOTTOM") >= 0 ? b.y + b.height - (2 * hh) / 3 : b.y - hh / 3
        moveAbs(node, ax, ay)
        if (source && "stuckTo" in node) {
          try { node.stuckTo = target } catch (error) { /* not a stickable host */ }
        }
      } else await place(node, input)
      made.push(node)
    }
    var out = { ids: made.map(function (n) { return n.id }), created: made.map(describe), native: !!source }
    if (!source) out.note = "No native \"" + kind.key + "\" stamp exists on this board and plugins can't create stamps, so an emoji stand-in was used. If the user stamps one by hand, later calls will clone it."
    return out
  })

// Board URL: figma.fileKey (private plugins only) or a link the user pasted.
var BOARD_URL_KEY = "maximal.boardUrl"
var LINK_HINT = "Ask the user for the board's share link (Share → Copy link) and call set_board_url."

function parseBoardUrl(url) {
  var m = /figma\.com\/(board|file|design|proto)\/([A-Za-z0-9]+)/.exec(String(url || ""))
  return m ? { kind: m[1], fileKey: m[2] } : undefined
}

function boardUrl() {
  var stored = ""
  try { stored = figma.root.getPluginData(BOARD_URL_KEY) } catch (error) { stored = "" }
  if (stored) {
    var parsed = parseBoardUrl(stored)
    var baseUrl = stored.split("#")[0].split("?")[0]
    return { url: baseUrl, fileKey: parsed && parsed.fileKey, source: "set_board_url" }
  }
  var key
  try { key = figma.fileKey } catch (error) { key = undefined }
  if (key) return { url: "https://www.figma.com/board/" + key + "/", fileKey: key, source: "fileKey" }
  return { url: null, fileKey: null, hint: LINK_HINT }
}

function nodeLink(id) {
  var b = boardUrl()
  if (!b.url) return null
  return b.url + "?node-id=" + encodeURIComponent(String(id).replace(/:/g, "-"))
}

tool("set_board_url",
  "Remember this board's share URL (pasted by the user, e.g. https://www.figma.com/board/AbC123/Name) so get_link can produce links to pages and nodes. Stored in the file.",
  { url: str("The board's figma.com URL.") }, ["url"],
  async function (input) {
    var parsed = parseBoardUrl(input.url)
    if (!parsed) throw new Error("That doesn't look like a Figma board URL (expected figma.com/board/<key>/…, /file/<key>/… or /design/<key>/…).")
    var clean = String(input.url).trim().split("#")[0].split("?")[0]
    figma.root.setPluginData(BOARD_URL_KEY, clean)
    return { url: clean, fileKey: parsed.fileKey }
  })

tool("get_link",
  "Get shareable links: the board URL, links to given nodes (opens the board zoomed to them), and links to every page. Include links to what you made in your final reply. If no URL is known, returns url null and a hint: ask the user for the share link and call set_board_url.",
  { ids: arr(str(), "Node ids to link (default: the current selection)."), pages: bool("Include a link per page (default true).") }, [],
  async function (input) {
    var b = boardUrl()
    var out = { url: b.url, fileKey: b.fileKey || null }
    if (!b.url) {
      out.hint = LINK_HINT
      return out
    }
    var ids = Array.isArray(input.ids) && input.ids.length ? input.ids : figma.currentPage.selection.map(function (n) { return n.id })
    if (ids.length > 100) throw new Error("At most 100 ids per call.")
    var nodes = []
    for (var i = 0; i < ids.length; i++) {
      var n = await getNode(ids[i])
      nodes.push({ id: n.id, type: n.type, name: n.name, link: nodeLink(n.id) })
    }
    out.nodes = nodes
    if (input.pages !== false) {
      out.pages = figma.root.children.map(function (p) {
        return { id: p.id, name: p.name, current: p === figma.currentPage, link: nodeLink(p.id) }
      })
    }
    return out
  }, { readOnly: true })

// ------------------------------------------------------------------ tools: comments (REST API)
//
// The Plugin API has no comments surface, so these tools call Figma's REST API
// from the sandbox with a personal access token the user pasted into the
// panel's Settings → Figma access token. The token lives only in
// figma.clientStorage under FIGMA_TOKEN_KEY (this computer, this plugin). The
// panel sends it once on save and only ever gets {hasToken, last4} back; it
// never goes into tool results, errors (they're scrubbed of it), logs, chats,
// bridge messages or the system prompt.
// Caveat: run_code can read figma.clientStorage, so code it runs could read the
// token. run_code is off by default; it runs only when the user ticks "Allow
// run_code" in the panel.
// These tools are readOnly: comments live outside the document (no undo step).
var FIGMA_TOKEN_KEY = "maximal.figmaToken"
var FIGMA_API = "https://api.figma.com/v1"
var FIGMA_API_TIMEOUT_MS = 20000
var NO_FIGMA_TOKEN = "No Figma token: add one in the panel's Settings → Figma access token."
var COMMENT_LIMITS = "Comments can't be resolved, edited or deleted through the API; ask the user to do that in Figma."

async function loadFigmaToken() {
  var token
  try { token = await figma.clientStorage.getAsync(FIGMA_TOKEN_KEY) } catch (error) { token = undefined }
  return typeof token === "string" ? token : ""
}

// All the panel ever learns about the token.
function figmaTokenStatus(token) {
  return token ? { hasToken: true, last4: token.slice(-4) } : { hasToken: false, last4: "" }
}

function scrubToken(text, token) {
  text = String(text)
  return token ? text.split(token).join("[token]") : text
}

function commentsFileKey() {
  var key
  try { key = figma.fileKey } catch (error) { key = undefined }
  if (key) return key
  var b = boardUrl()
  if (b.fileKey) return b.fileKey
  throw toolError("no_file_key", "This board's file key isn't available, so its comments can't be reached. " + LINK_HINT)
}

// Figma's sandbox fetch returns headersObject; a standard Response has headers.get.
function responseHeader(res, name) {
  try {
    if (res.headers && typeof res.headers.get === "function") return res.headers.get(name)
  } catch (error) {
    // fall through to headersObject
  }
  var h = res.headersObject || res.headers
  if (!h || typeof h !== "object") return null
  var keys = Object.keys(h)
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name.toLowerCase()) return h[keys[i]]
  return null
}

function figmaApiError(status, retryAfter, data, text, what) {
  var detail = ""
  if (data && typeof data === "object") detail = data.err || data.message || (typeof data.error === "string" ? data.error : "")
  if (!detail) detail = String(text || "").slice(0, 200)
  var said = detail ? " Figma said: " + detail : ""
  if (status === 401 || status === 403) {
    return toolError("forbidden", "Figma refused the request (" + status + "): the token is missing a scope (file_comments:read to read, file_comments:write to post or react, file_content:read), has expired, or its account has no access to this file. The user can save a new token in the panel's Settings → Figma access token." + said)
  }
  if (status === 404) return toolError("not_found", "Not found (404): Figma has no " + what + " that this token's account can see." + said)
  if (status === 429) {
    var seconds = parseInt(retryAfter, 10)
    return toolError("rate_limited", "Figma rate-limited this token (429): retry after " + (isFinite(seconds) ? seconds + " seconds" : "a minute") + "." + said, isFinite(seconds) ? { retryAfter: seconds } : undefined)
  }
  if (status === 400) return toolError("bad_request", "Figma rejected the request (400)." + said)
  return toolError("http_error", "Figma's API answered " + status + "." + said)
}

// One REST call with the stored token. `what` names the thing for a 404.
async function figmaApi(method, path, body, what) {
  var token = await loadFigmaToken()
  if (!token) throw toolError("no_token", NO_FIGMA_TOKEN)
  if (typeof fetch !== "function") throw toolError("unsupported", "This Figma version's plugin sandbox has no fetch, so comments can't be reached.")
  var init = { method: method, headers: { "X-Figma-Token": token } }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  var timer
  var reply
  try {
    reply = await Promise.race([
      fetch(FIGMA_API + path, init).then(function (res) {
        return res.text().then(function (text) { return { res: res, text: text } }, function () { return { res: res, text: "" } })
      }),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () { reject(toolError("timeout", "Figma's API didn't answer within " + FIGMA_API_TIMEOUT_MS / 1000 + " seconds. Try again.")) }, FIGMA_API_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    if (error && error.code === "timeout") throw error
    throw toolError("network", "Couldn't reach Figma's API: " + scrubToken(errorText(error), token))
  } finally {
    clearTimeout(timer)
  }
  var data = null
  try { data = reply.text ? JSON.parse(reply.text) : null } catch (error) { data = null }
  if (reply.res.status >= 200 && reply.res.status < 300) return data
  var failure = figmaApiError(reply.res.status, responseHeader(reply.res, "Retry-After"), data, reply.text, what)
  failure.message = scrubToken(failure.message, token)
  throw failure
}

function commentNodeId(c) {
  var meta = c && c.client_meta
  return meta && typeof meta.node_id === "string" ? meta.node_id : null
}

function commentAuthor(c) {
  return c && c.user ? c.user.handle || c.user.id || null : null
}

// [{emoji, count, by: [handles]}], in first-reacted order.
function reactionSummary(reactions) {
  var out = []
  var byEmoji = {}
  ;(Array.isArray(reactions) ? reactions : []).forEach(function (r) {
    if (!r || !r.emoji) return
    var entry = byEmoji[r.emoji]
    if (!entry) {
      entry = byEmoji[r.emoji] = { emoji: r.emoji, count: 0, by: [] }
      out.push(entry)
    }
    entry.count++
    var who = r.user ? r.user.handle || r.user.id : null
    if (who) entry.by.push(who)
  })
  return out
}

function commentOut(c) {
  return { id: c.id, author: commentAuthor(c), message: c.message, createdAt: c.created_at || null, reactions: reactionSummary(c.reactions) }
}

function byCreated(a, b) {
  var x = String(a.created_at || "")
  var y = String(b.created_at || "")
  return x < y ? -1 : x > y ? 1 : 0
}

async function nodeNameIfLoaded(id) {
  try {
    var n = await figma.getNodeByIdAsync(String(id))
    return n && !n.removed ? n.name : null
  } catch (error) {
    return null
  }
}

tool("get_comments",
  "Read this board's Figma comments as threads: {id, author, message, createdAt, resolvedAt, nodeId (the node it's pinned to), nodeName, reactions, replies}. Works when the user saved a Figma access token in the panel's Settings; without one it says how to add one. Unresolved threads only unless includeResolved. " + COMMENT_LIMITS,
  {
    nodeIds: arr(str(), "Only threads pinned to these node ids."),
    includeResolved: bool("Include resolved threads (default false)."),
    markdown: bool("Return messages as Markdown where Figma has it."),
  }, [],
  async function (input) {
    var key = commentsFileKey()
    var data = await figmaApi("GET", "/files/" + encodeURIComponent(key) + "/comments" + (input.markdown ? "?as_md=true" : ""), undefined, "file " + key)
    var all = data && Array.isArray(data.comments) ? data.comments.slice() : []
    all.sort(byCreated)
    var threads = []
    var byId = {}
    all.forEach(function (c) {
      if (c.parent_id) return
      var t = commentOut(c)
      t.resolvedAt = c.resolved_at || null
      t.nodeId = commentNodeId(c)
      t.nodeName = null
      t.replies = []
      byId[c.id] = t
      threads.push(t)
    })
    all.forEach(function (c) {
      if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(commentOut(c))
    })
    var wanted = Array.isArray(input.nodeIds) && input.nodeIds.length ? input.nodeIds.map(String) : null
    var resolvedHidden = 0
    threads = threads.filter(function (t) {
      if (wanted && wanted.indexOf(t.nodeId) < 0) return false
      if (t.resolvedAt && !input.includeResolved) {
        resolvedHidden++
        return false
      }
      return true
    })
    for (var i = 0; i < threads.length; i++) if (threads[i].nodeId) threads[i].nodeName = await nodeNameIfLoaded(threads[i].nodeId)
    var out = { fileKey: key, count: threads.length, threads: threads }
    if (resolvedHidden) out.resolvedHidden = resolvedHidden
    if (!threads.length) {
      out.note = "No " + (input.includeResolved ? "" : "unresolved ") + "comments" + (wanted ? " pinned to those nodes" : " on this board") + "." + (resolvedHidden ? " " + resolvedHidden + " resolved thread(s) hidden; pass includeResolved: true to see them." : "")
    }
    out.limits = COMMENT_LIMITS
    return out
  }, { readOnly: true })

tool("add_comment",
  "Post a Figma comment on this board as the token's owner: top-level, pinned to a node (nodeId), or a reply to a thread (replyTo = the thread's id from get_comments). Only post when the user asked you to comment; otherwise say what you'd write, or use a sticky for your own notes. Needs the user's Figma access token (panel Settings). " + COMMENT_LIMITS,
  {
    message: str("The comment text."),
    nodeId: str("Pin the comment to this node (id from a read)."),
    replyTo: str("Reply to this thread (top-level comment id from get_comments). Replies can't be pinned."),
  }, ["message"],
  async function (input) {
    var message = typeof input.message === "string" ? input.message.trim() : ""
    if (!message) throw toolError("bad_input", "message is required.")
    if (input.nodeId && input.replyTo) throw toolError("bad_input", "Pass nodeId or replyTo, not both: replies sit in their thread and can't be pinned.")
    var key = commentsFileKey()
    var body = { message: message }
    var nodeName = null
    if (input.replyTo) body.comment_id = String(input.replyTo)
    if (input.nodeId) {
      var node = await lookupAny(input.nodeId)
      if (!node) throw toolError("not_found", "No node with id " + input.nodeId + ".")
      nodeName = node.name
      body.client_meta = { node_id: node.id, node_offset: { x: 0, y: 0 } }
    }
    var posted
    try {
      posted = await figmaApi("POST", "/files/" + encodeURIComponent(key) + "/comments", body, input.replyTo ? "comment " + input.replyTo + " in file " + key : "file " + key)
    } catch (error) {
      if (body.client_meta && error && error.code === "bad_request") {
        error.message += " Pinning comments to nodes may not work on FigJam boards: retry without nodeId to post an unpinned comment (mention the node in the text)."
      }
      throw error
    }
    var out = { posted: true, replyTo: input.replyTo ? String(input.replyTo) : null, nodeId: body.client_meta ? body.client_meta.node_id : null, nodeName: nodeName }
    if (posted && posted.id) {
      out.comment = commentOut(posted)
      if (out.nodeId && commentNodeId(posted) !== out.nodeId) out.note = "Figma posted the comment but didn't keep the node pin."
    }
    return out
  }, { readOnly: true })

tool("react_to_comment",
  "Add an emoji reaction to a Figma comment (id from get_comments), as the token's owner. Only when the user asked. Needs the user's Figma access token (panel Settings).",
  {
    commentId: str("Comment id from get_comments (a thread or a reply)."),
    emoji: str("Emoji shortcode, e.g. :+1:, :heart:, :eyes:, :tada:."),
  }, ["commentId", "emoji"],
  async function (input) {
    var commentId = String(input.commentId || "").trim()
    var emoji = String(input.emoji || "").trim()
    if (!commentId || !emoji) throw toolError("bad_input", "commentId and emoji are required.")
    if (/^[a-z0-9_+-]+$/i.test(emoji)) emoji = ":" + emoji + ":"
    var key = commentsFileKey()
    await figmaApi("POST", "/files/" + encodeURIComponent(key) + "/comments/" + encodeURIComponent(commentId) + "/reactions", { emoji: emoji }, "comment " + commentId + " in file " + key)
    return { reacted: true, commentId: commentId, emoji: emoji }
  }, { readOnly: true })

// ------------------------------------------------------------------ tools: layout review

function solidColor(paints) {
  if (!Array.isArray(paints)) return undefined
  for (var i = paints.length - 1; i >= 0; i--) {
    if (paints[i].type === "SOLID" && paints[i].visible !== false) return paints[i].color
  }
  return undefined
}

function luminance(c) {
  function ch(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

function contrastRatio(a, b) {
  var la = luminance(a)
  var lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function overlapArea(a, b) {
  var w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  var hh = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && hh > 0 ? w * hh : 0
}

function segsCross(p1, p2, p3, p4) {
  function o(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) }
  var d1 = o(p3, p4, p1)
  var d2 = o(p3, p4, p2)
  var d3 = o(p1, p2, p3)
  var d4 = o(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function segHitsBox(p, q, b) {
  // Sample the segment; good enough for layout hints.
  for (var t = 0.1; t < 0.95; t += 0.1) {
    var x = p.x + (q.x - p.x) * t
    var y = p.y + (q.y - p.y) * t
    if (x > b.x + 4 && x < b.x + b.width - 4 && y > b.y + 4 && y < b.y + b.height - 4) return true
  }
  return false
}

// Page point where a connector end attaches (side midpoint of the node's box).
async function endPoint(ep) {
  if (!ep) return undefined
  if (isFloating(ep)) return ep.position ? { x: ep.position.x, y: ep.position.y } : undefined
  var n = await figma.getNodeByIdAsync(ep.endpointNodeId)
  if (!n || !("absoluteTransform" in n)) return undefined
  var b = bbox(n)
  var m = ep.magnet
  if (m === "TOP") return { x: b.x + b.width / 2, y: b.y }
  if (m === "BOTTOM") return { x: b.x + b.width / 2, y: b.y + b.height }
  if (m === "LEFT") return { x: b.x, y: b.y + b.height / 2 }
  if (m === "RIGHT") return { x: b.x + b.width, y: b.y + b.height / 2 }
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, center: true, box: b }
}

function isMarker(n) {
  return n.type === "STAMP" || n.type === "VECTOR" || n.type === "HIGHLIGHT" || /^Stamp:/.test(n.name || "") ||
    (n.type === "SHAPE_WITH_TEXT" && n.shapeType === "ELLIPSE" && n.width <= 72 && n.height <= 72)
}

function fontSizeOf(t) {
  try {
    return typeof t.fontSize === "number" ? t.fontSize : undefined
  } catch (error) {
    return undefined
  }
}

function lineGroups(items, key, tol) {
  // Group boxes whose `key` center is within tol of the group's first member.
  var sorted = items.slice().sort(function (a, b) { return a[key] - b[key] })
  var groups = []
  for (var i = 0; i < sorted.length; i++) {
    var g = groups[groups.length - 1]
    if (g && Math.abs(sorted[i][key] - g[0][key]) <= tol) g.push(sorted[i])
    else groups.push([sorted[i]])
  }
  return groups
}

async function reviewContainer(container, kids, issues, connectors) {
  var items = []
  for (var i = 0; i < kids.length; i++) {
    var n = kids[i]
    if (n.type === "CONNECTOR") {
      connectors.push(n)
      continue
    }
    if (!n.visible || !("absoluteTransform" in n)) continue
    var b = bbox(n)
    items.push({ node: n, b: b, cx: b.x + b.width / 2, cy: b.y + b.height / 2, marker: isMarker(n) })
  }
  var solids = items.filter(function (it) { return !it.marker })

  // Overlaps.
  for (var a = 0; a < solids.length; a++) {
    for (var c = a + 1; c < solids.length; c++) {
      var area = overlapArea(solids[a].b, solids[c].b)
      if (area > 4) issues.push({ type: "overlap", ids: [solids[a].node.id, solids[c].node.id], message: solids[a].node.type + " and " + solids[c].node.type + " overlap.", fix: "Move one of them (arrange_grid / distribute) so there's a gap of at least 24px." })
    }
  }

  // Text size / overflow / contrast on shapes, stickies and text.
  for (var t = 0; t < solids.length; t++) {
    var node = solids[t].node
    var bx = solids[t].b
    var sub = node.type === "TEXT" ? node : (node.type === "SHAPE_WITH_TEXT" || node.type === "STICKY") ? node.text : undefined
    if (!sub) continue
    var chars = ""
    try { chars = sub.characters || "" } catch (error) { chars = "" }
    var fs = fontSizeOf(sub)
    if (fs && node.type === "SHAPE_WITH_TEXT" && Math.min(bx.width, bx.height) >= 80 && bx.width >= 120 && fs < 14 && chars) {
      issues.push({ type: "text-too-small", ids: [node.id], message: "Font " + fs + "px is small for a " + Math.round(bx.width) + "×" + Math.round(bx.height) + " shape.", fix: "update_node fontSize 16–18 (or larger for big shapes)." })
    }
    if (fs && chars && node.type === "SHAPE_WITH_TEXT") {
      var perLine = Math.max(1, Math.floor((bx.width - 24) / (fs * 0.55)))
      var lines = 0
      chars.split("\n").forEach(function (l) { lines += Math.max(1, Math.ceil(l.length / perLine)) })
      if (lines * fs * 1.3 > bx.height - 12) issues.push({ type: "text-overflow", ids: [node.id], message: "Text likely overflows the shape (~" + lines + " lines at " + fs + "px).", fix: "Enlarge the shape, shorten the text, or lower the font size." })
    }
    if (fs && chars.trim()) {
      var fam = ""
      try { fam = sub.fontName && sub.fontName !== figma.mixed ? sub.fontName.family : "" } catch (error) { fam = "" }
      if (fam && !rampMatch(fs, fam, node.type === "STICKY")) {
        var near = nearestRole(fs, fam)
        issues.push({ type: "off-ramp-text", priority: "low", ids: [node.id], message: "Text is " + fam + " " + fs + "px, which matches no type ramp role.", fix: "update_node textStyle " + near.role + " (" + FONT_PRESETS[near.family][0].family + " " + near.style + " " + near.size + "/" + near.lineHeight + ")." })
      }
    }
    if (fs && node.type === "TEXT" && fs < 12) issues.push({ type: "text-too-small", ids: [node.id], message: "Text is " + fs + "px; unreadable at 100% zoom.", fix: "Use ≥ 14px (16–18 for body, 32+ headings)." })
    var bg = node.type === "TEXT" ? (container.type === "SECTION" ? solidColor(container.fills) : WHITE) : solidColor(node.fills)
    var fg
    try { fg = solidColor(sub.fills) } catch (error) { fg = undefined }
    if (bg && fg && chars) {
      var ratio = contrastRatio(fg, bg)
      var need = fs && fs >= 18 ? 3 : 4.5
      if (ratio < need) issues.push({ type: "low-contrast", ids: [node.id], message: "Text contrast " + ratio.toFixed(2) + ":1 (" + hex(fg) + " on " + hex(bg) + ") is below " + need + ":1.", fix: "Use a darker/lighter textColor or a lighter fill (e.g. white text on dark presets, charcoal on light)." })
    }
  }

  // Rows/columns: uneven gaps and near-miss alignment.
  function gapsCheck(axis) {
    var key = axis === "row" ? "cy" : "cx"
    var groups = lineGroups(solids, key, 6)
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g]
      if (grp.length < 2) continue
      var off = grp.filter(function (it) { return Math.abs(it[key] - grp[0][key]) > 0.5 })
      if (off.length) issues.push({ type: "near-miss-alignment", ids: grp.map(function (it) { return it.node.id }), message: "These look like a " + axis + " but their centers are off by 1–6px.", fix: "align " + (axis === "row" ? "centerY" : "centerX") + " on these ids." })
      if (grp.length < 3) continue
      grp.sort(function (p, q) { return axis === "row" ? p.b.x - q.b.x : p.b.y - q.b.y })
      var gaps = []
      for (var k = 1; k < grp.length; k++) {
        gaps.push(axis === "row" ? grp[k].b.x - (grp[k - 1].b.x + grp[k - 1].b.width) : grp[k].b.y - (grp[k - 1].b.y + grp[k - 1].b.height))
      }
      var min = Math.min.apply(null, gaps)
      var max = Math.max.apply(null, gaps)
      if (max - min > 8) issues.push({ type: "uneven-gaps", ids: grp.map(function (it) { return it.node.id }), message: "Gaps in this " + axis + " range " + Math.round(min) + "–" + Math.round(max) + "px.", fix: "distribute " + (axis === "row" ? "horizontal" : "vertical") + " with a fixed gap (≥ 64px for connected flows)." })
    }
  }
  gapsCheck("row")
  gapsCheck("column")
  // Left/top edges almost equal.
  var edgeIssues = 0
  for (var e1 = 0; e1 < solids.length && edgeIssues < 10; e1++) {
    for (var e2 = e1 + 1; e2 < solids.length && edgeIssues < 10; e2++) {
      var dxl = Math.abs(solids[e1].b.x - solids[e2].b.x)
      var dyt = Math.abs(solids[e1].b.y - solids[e2].b.y)
      if ((dxl >= 1 && dxl <= 6) || (dyt >= 1 && dyt <= 6)) {
        edgeIssues++
        issues.push({ type: "near-miss-alignment", ids: [solids[e1].node.id, solids[e2].node.id], message: "Edges are " + Math.round(dxl >= 1 && dxl <= 6 ? dxl : dyt) + "px apart (" + (dxl >= 1 && dxl <= 6 ? "left" : "top") + ").", fix: "align " + (dxl >= 1 && dxl <= 6 ? "left" : "top") + " on these ids." })
      }
    }
  }

  // Color: too many unexplained hues.
  var fills = {}
  for (var f = 0; f < solids.length; f++) {
    var sn = solids[f].node
    if (sn.type !== "STICKY" && sn.type !== "SHAPE_WITH_TEXT") continue
    var col = solidColor(sn.fills)
    if (col) fills[hex(col)] = (fills[hex(col)] || []).concat([sn.id])
  }
  var hues = Object.keys(fills)
  if (hues.length > 4) {
    var legend = solids.some(function (it) { return /legend|key/i.test(it.node.name || "") || (it.node.type === "TEXT" && /legend|key|=|:/i.test(textOf(it.node) || "")) })
    if (!legend) issues.push({ type: "unexplained-colors", ids: [container.id], message: hues.length + " different fill colors (" + hues.join(", ") + ") with no legend.", fix: "Pick one meaning for color (stage/status/owner/sentiment), use ≤ 4 hues + a neutral, recolor, and add a small legend (text or labeled stickies)." })
  }

  // Section fit, padding and balance.
  if (container.type === "SECTION" && solids.length) {
    var sb = bbox(container)
    var content = unionBox(solids.map(function (it) { return it.node }))
    var pad = { top: content.y - sb.y, bottom: sb.y + sb.height - (content.y + content.height), left: content.x - sb.x, right: sb.x + sb.width - (content.x + content.width) }
    var outside = solids.filter(function (it) { return it.b.x < sb.x - 1 || it.b.y < sb.y - 1 || it.b.x + it.b.width > sb.x + sb.width + 1 || it.b.y + it.b.height > sb.y + sb.height + 1 })
    if (outside.length) issues.push({ type: "outside-section", ids: outside.map(function (it) { return it.node.id }), message: outside.length + " node(s) stick out of section \"" + container.name + "\".", fix: "fit_section " + container.id + " (or move them inside)." })
    var tight = Object.keys(pad).filter(function (k) { return pad[k] < 40 && pad[k] >= -1 })
    if (tight.length) issues.push({ type: "tight-padding", ids: [container.id], message: "Section padding is under 40px on: " + tight.join(", ") + ".", fix: "fit_section " + container.id + " (padding 48)." })
    function unbalanced(p, q) { var lo = Math.max(1, Math.min(p, q)); return Math.max(p, q) / lo > 1.5 && Math.abs(p - q) > 24 }
    var vert = unbalanced(pad.top, pad.bottom)
    var horiz = unbalanced(pad.left, pad.right)
    if (vert || horiz) issues.push({ type: "unbalanced-section", ids: [container.id], message: "Content isn't centered in \"" + container.name + "\": padding top " + Math.round(pad.top) + ", bottom " + Math.round(pad.bottom) + ", left " + Math.round(pad.left) + ", right " + Math.round(pad.right) + ".", fix: "fit_section " + container.id + " to wrap the content evenly, or move the content to the middle." })
    var fillRatio = (content.width * content.height) / Math.max(1, sb.width * sb.height)
    if (fillRatio < 0.3 && !vert && !horiz) issues.push({ type: "section-too-large", ids: [container.id], message: "Content covers only " + Math.round(fillRatio * 100) + "% of the section.", fix: "fit_section " + container.id + "." })
  }
  return items
}

tool("type_ramp",
  "The canvas type ramp as data: each role's family preset, installed family, style, size, line height (4px grid), letter spacing (%), case, the size it snaps to on stickies, and what it's for. Plan text with these roles and pass textStyle on create_text, create_stickies, create_shape, create_label, create_table, update_node and style_text.",
  {}, [],
  async function () {
    await fontMemory()
    return { roles: rampOut(), rules: ["One role per hierarchy level; at most 3 roles per section.", "Card titles: code-label or subhead; card descriptions: caption or body (never < 13px on large canvases).", "Canvases viewed zoomed out (big maps): step every role up one level.", "Sticky text only takes " + STICKY_TEXT_SIZES.join("/") + "px; role sizes snap to the nearest."] }
  }, { readOnly: true })

tool("review_layout",
  "Check layout quality by geometry (no image needed) and return concrete issues with node ids and suggested fixes: off-ramp text (size/family matching no type_ramp role; low priority), overlaps, text too small / likely overflowing, low text contrast (WCAG), uneven gaps in rows/columns, near-miss alignment (1–6px), section padding < 40px or unbalanced (content not centered), sections too large or with content sticking out, connectors that are short stubs (< 40px), pass through other nodes, or cross each other, and > 4 fill colors with no legend. Run it after building anything, fix every issue, then export_png and look critically, then run it again.",
  {
    sectionId: str("Review this section (its contents and padding)."),
    ids: arr(str(), "Review these nodes (sections among them are reviewed with their contents)."),
  }, [],
  async function (input) {
    var issues = []
    var connectors = []
    var scope
    var all = []
    var containers = []
    if (input.sectionId) {
      var s = await getSection(input.sectionId)
      containers.push({ c: s, kids: s.children })
      scope = "section " + s.name
    } else if (Array.isArray(input.ids) && input.ids.length) {
      var nodes = await getNodes(input.ids, 300)
      containers.push({ c: activePage(), kids: nodes.filter(function (n) { return n.type !== "SECTION" }) })
      nodes.forEach(function (n) { if (n.type === "SECTION") containers.push({ c: n, kids: n.children }) })
      scope = nodes.length + " nodes"
    } else {
      var top = activePage().children
      containers.push({ c: activePage(), kids: top })
      top.forEach(function (n) { if (n.type === "SECTION") containers.push({ c: n, kids: n.children }) })
      scope = "page " + activePage().name
    }
    var checked = 0
    for (var i = 0; i < containers.length; i++) {
      if (containers[i].kids.length > 400) {
        issues.push({ type: "skipped", ids: [containers[i].c.id], message: "Too many children to review (" + containers[i].kids.length + ").", fix: "Review a section or a set of ids." })
        continue
      }
      var items = await reviewContainer(containers[i].c, containers[i].kids, issues, connectors)
      checked += items.length
      all = all.concat(items.filter(function (it) { return !it.marker && it.node.type !== "SECTION" }))
    }
    // Connectors: length, pass-through, crossings (approximate, end to end).
    var segs = []
    for (var k = 0; k < connectors.length && k < 200; k++) {
      var cn = connectors[k]
      var p = await endPoint(cn.connectorStart)
      var q = await endPoint(cn.connectorEnd)
      if (!p || !q) continue
      var len = cn.connectorLineType === "ELBOWED" ? Math.abs(p.x - q.x) + Math.abs(p.y - q.y) : Math.hypot(p.x - q.x, p.y - q.y)
      if (len < 40) issues.push({ type: "short-connector", ids: [cn.id], message: "Connector is ~" + Math.round(len) + "px long; it reads as a stub, not an arrow.", fix: "Spread the connected nodes apart (gap ≥ 64px)." })
      var ends = [cn.connectorStart && cn.connectorStart.endpointNodeId, cn.connectorEnd && cn.connectorEnd.endpointNodeId]
      for (var j = 0; j < all.length; j++) {
        if (ends.indexOf(all[j].node.id) >= 0) continue
        if (segHitsBox(p, q, all[j].b)) {
          issues.push({ type: "connector-through-node", ids: [cn.id, all[j].node.id], message: "Connector appears to pass through another node.", fix: "Move that node out of the path, or change magnets so the line routes around it." })
          break
        }
      }
      segs.push({ id: cn.id, p: p, q: q, ends: ends })
    }
    var crossings = 0
    for (var x1 = 0; x1 < segs.length && crossings < 10; x1++) {
      for (var x2 = x1 + 1; x2 < segs.length && crossings < 10; x2++) {
        var A = segs[x1]
        var B = segs[x2]
        if (A.ends.some(function (id) { return id && B.ends.indexOf(id) >= 0 })) continue
        if (segsCross(A.p, A.q, B.p, B.q)) {
          crossings++
          issues.push({ type: "connector-crossing", ids: [A.id, B.id], message: "These connectors likely cross.", fix: "Reorder or move nodes so edges don't cross (approximate check)." })
        }
      }
    }
    var counts = {}
    issues.forEach(function (it) { counts[it.type] = (counts[it.type] || 0) + 1 })
    return { scope: scope, checked: checked, connectors: segs.length, issueCount: issues.length, counts: counts, issues: issues.slice(0, 80), truncated: issues.length > 80 }
  }, { readOnly: true })

tool("fit_section",
  "Resize sections to wrap their contents with even padding on every side (default 48) plus extra top room for the title, keeping the content where it is on the page. Use after review_layout flags unbalanced/tight/oversized sections.",
  { ids: arr(str(), "Section ids."), padding: num("Padding (default 48)."), headerGap: num("Extra space above the content for the section title (default 24).") }, ["ids"],
  async function (input) {
    var nodes = await getNodes(input.ids, 50)
    var out = []
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].type !== "SECTION") throw new Error("Node " + nodes[i].id + " is a " + nodes[i].type + ", not a SECTION.")
      fitSectionTight(nodes[i], clamp(input.padding, 0, 400, PAD), clamp(input.headerGap, 0, 400, 24))
      out.push(describe(nodes[i]))
    }
    return { sections: out }
  })

// ------------------------------------------------------------------ tools: editing

var UPDATE_PROPS = {
  id: str(),
  text: str("Replace the text (stickies, shapes, text, connector labels, code blocks)."),
  color: str("Palette color for the node type (sticky, section tint, shape preset, connector) or hex."),
  name: str(),
  sectionId: str("Move the node into this section (then x/y are section-relative)."),
  x: num(),
  y: num(),
  width: num(),
  height: num(),
  fill: str("Custom fill, hex or palette name."),
  stroke: str("Custom stroke, hex or palette name."),
  textColor: str("Text color, hex or palette name."),
  strokeWeight: num(),
  dashPattern: arr(num(), "e.g. [10, 6]; [] for solid."),
  fillMode: str("Toolbar fill mode: fill, transparent (translucent tint) or none."),
  strokeMode: str("Toolbar stroke mode: solid, dashed or none."),
  fontSize: FONT_SIZE,
  fontFamily: FONT_FAMILY,
  textStyle: TEXT_STYLE,
  opacity: num("0–1."),
  rotation: num("Degrees, about the node's center."),
  locked: bool(),
  visible: bool(),
  shape: str("New shape type for a shape-with-text."),
  wide: bool("Sticky: wide shape."),
  authorVisible: bool("Sticky: show the author."),
  contentsHidden: bool("Section: hide its contents."),
  fitToContents: bool("Section: shrink/grow to its contents plus padding (keeps content in place)."),
  padding: num("Padding for fitToContents (default 48)."),
  code: str("Code block content."),
  language: str("Code block language."),
  fromId: str(),
  toId: str(),
  startMagnet: str(MAGNET_DESC),
  endMagnet: str(MAGNET_DESC),
  fromPoint: obj(POINT),
  toPoint: obj(POINT),
  lineType: str("Connector: ELBOWED, STRAIGHT or CURVED."),
  label: str("Connector label."),
  autoRoute: bool("Connector: re-pick facing sides and line type from the end nodes' current positions (use after moving nodes)."),
  arrow: bool(),
  startCap: str("Connector start cap: " + CAP_DESC),
  endCap: str("Connector end cap: " + CAP_DESC),
  flipH: bool("Mirror left-right about the node's center (position kept). Some node types (stickies, sections, tables) may refuse a mirrored transform; the error is returned."),
  flipV: bool("Mirror top-bottom about the node's center (position kept)."),
  lockMode: str("Section: \"all\" (section and every child locked), \"background\" (section locked, children unlocked; FigJam may still treat children of a locked section as locked) or \"none\" (unlock section and children)."),
  reverse: bool("Connector: swap direction (ends incl. magnets/points, and start/end caps)."),
}

// Mirror a 2x3 transform in the node's own space about its center: the
// bounding box and center stay put, only the content is reflected.
function flipTransform(t, w, hh, horiz, vert) {
  var a = t[0][0], c = t[0][1], tx = t[0][2]
  var b = t[1][0], d = t[1][1], ty = t[1][2]
  if (horiz) { tx += a * w; ty += b * w; a = -a; b = -b }
  if (vert) { tx += c * hh; ty += d * hh; c = -c; d = -d }
  return [[a, c, tx], [b, d, ty]]
}

function copyEndpoint(ep) {
  if (!ep) return ep
  if (isFloating(ep)) return { position: { x: ep.position.x, y: ep.position.y } }
  var out = { endpointNodeId: ep.endpointNodeId, magnet: ep.magnet || "AUTO" }
  if (ep.position) out.position = { x: ep.position.x, y: ep.position.y }
  return out
}

function reverseConnector(node) {
  var s = copyEndpoint(node.connectorStart)
  var e = copyEndpoint(node.connectorEnd)
  var sc = node.connectorStartStrokeCap
  var ec = node.connectorEndStrokeCap
  node.connectorStart = e
  node.connectorEnd = s
  if (sc !== undefined && ec !== undefined) {
    node.connectorStartStrokeCap = ec
    node.connectorEndStrokeCap = sc
  }
}

tool("update_node",
  "Change an existing node: text, color (palette, toolbar swatch like \"light blue\", or hex), fill/stroke/text color, fillMode (fill | transparent | none), strokeMode (solid | dashed | none), stroke weight, dashes, font size (px or small…huge), fontFamily (simple | bookish | technical | scribbled or a family), name, position, size, rotation, flipH/flipV (mirror about center), opacity, lock, visibility, move into a section; sticky wide/author; shape type; section contentsHidden/fitToContents/lockMode (all | background | none); code/language. For connectors: fromId/toId, startMagnet/endMagnet, fromPoint/toPoint, lineType, label, arrow, startCap/endCap, reverse (swap direction); autoRoute (or re-pointing an end without magnets) re-picks facing sides like connect does.",
  UPDATE_PROPS, ["id"],
  async function (input) {
    var node = await getNode(input.id)
    input = await resolveTextOptions(input, node.type)
    if (input.reverse) {
      if (node.type !== "CONNECTOR") throw new Error("Only connectors can be reversed.")
      reverseConnector(node)
    }
    if (node.type === "CONNECTOR") {
      // Auto-route: re-pick facing sides (and STRAIGHT vs ELBOWED) from geometry.
      var reEnd = (input.fromId || input.toId) && !input.startMagnet && !input.endMagnet && !input.fromPoint && !input.toPoint
      if (input.autoRoute || reEnd) {
        var aId = input.fromId || (!isFloating(node.connectorStart) && node.connectorStart.endpointNodeId)
        var bId = input.toId || (!isFloating(node.connectorEnd) && node.connectorEnd.endpointNodeId)
        if (aId && bId) {
          var copy = {}
          for (var ck in input) copy[ck] = input[ck]
          var routed = await routeConnection({ fromId: aId, toId: bId, lineType: input.lineType })
          copy.fromId = aId
          copy.toId = bId
          copy.startMagnet = routed.start.magnet
          copy.endMagnet = routed.end.magnet
          copy.lineType = routed.lineType
          input = copy
        }
      }
      var lineType = input.lineType ? oneOf(LINE_TYPES, input.lineType, "lineType") : node.connectorLineType
      var straight = lineType === "STRAIGHT"
      // Leaving STRAIGHT: switch first so side magnets are accepted.
      if (input.lineType && !straight) node.connectorLineType = lineType
      if (input.fromId || input.fromPoint || input.startMagnet) {
        var s = await changeEnd(node.connectorStart, input.fromId, input.fromPoint, input.startMagnet)
        node.connectorStart = straight ? forStraight(s) : s
      }
      if (input.toId || input.toPoint || input.endMagnet) {
        var e = await changeEnd(node.connectorEnd, input.toId, input.toPoint, input.endMagnet)
        node.connectorEnd = straight ? forStraight(e) : e
      }
      // Entering STRAIGHT: move both ends to CENTER first, then switch.
      if (input.lineType && straight) {
        node.connectorStart = forStraight(node.connectorStart)
        node.connectorEnd = forStraight(node.connectorEnd)
        node.connectorLineType = "STRAIGHT"
      }
      var style = {}
      for (var k in input) if (k !== "lineType") style[k] = input[k]
      applyConnectorStyle(node, style)
      if (typeof input.label === "string") {
        await loadTextFont(node.text)
        node.text.characters = input.label
      }
    }
    if (typeof input.text === "string") {
      if (node.type === "CODE_BLOCK") await setCode(node, input.text)
      else {
        var t = textTarget(node)
        if (!t) throw new Error(node.type + " has no text.")
        await loadTextFont(t)
        t.characters = input.text
      }
    }
    if (node.type === "CODE_BLOCK" && (typeof input.code === "string" || input.language)) await setCode(node, input.code, input.language)
    if (input.shape) {
      if (node.type !== "SHAPE_WITH_TEXT") throw new Error("Only shapes-with-text have a shape type.")
      node.shapeType = oneOf(SHAPES, input.shape, "shape")
    }
    if (input.color && node.type !== "CONNECTOR") {
      if (node.type === "STICKY") node.fills = [solid(input.color, STICKY)]
      else if (node.type === "SECTION") node.fills = [solid(input.color, SECTION)]
      else if (node.type === "SHAPE_WITH_TEXT") {
        await loadFontFor(node)
        applyShapeColors(node, { color: input.color })
      }
      else if (node.type === "TABLE") node.fills = [solid(input.color, TABLE, "fill")]
      else if (node.type === "TEXT") node.fills = [solid(input.color)]
      else if ("fills" in node) node.fills = [solid(input.color)]
      else throw new Error("Can't color a " + node.type + ".")
    }
    if (input.fill && node.type !== "CONNECTOR") {
      if (!("fills" in node)) throw new Error(node.type + " has no fill.")
      var fillPalette = node.type === "STICKY" ? STICKY : node.type === "SECTION" ? SECTION : node.type === "TABLE" ? TABLE : SHAPE
      node.fills = [solid(input.fill, fillPalette, "fill")]
    }
    if (input.stroke && node.type !== "CONNECTOR") {
      if (!("strokes" in node)) throw new Error(node.type + " has no stroke.")
      node.strokes = [solid(input.stroke, SHAPE, "stroke")]
    }
    if (node.type !== "CONNECTOR") {
      if (typeof input.strokeWeight === "number") node.strokeWeight = input.strokeWeight
      if (Array.isArray(input.dashPattern)) node.dashPattern = input.dashPattern
      applyPaintModes(node, input)
    }
    if (input.fontFamily) {
      var ft = textTarget(node)
      if (!ft) throw new Error(node.type + " has no text.")
      await styleWhole(ft, { fontFamily: input.fontFamily, fontStyle: input.fontStyle })
    }
    if (input.textColor || typeof input.fontSize === "number") {
      var tt = textTarget(node)
      if (!tt) throw new Error(node.type + " has no text.")
      await loadTextFont(tt)
      if (input.textColor) tt.fills = [solid(input.textColor, SHAPE, "text")]
      if (typeof input.fontSize === "number") tt.fontSize = input.fontSize
    }
    if (input.__ramp) {
      var rt = textTarget(node)
      if (!rt) throw new Error(node.type + " has no text.")
      await styleWhole(rt, rampOpts(input))
    }
    if (node.type === "STICKY") {
      if (typeof input.wide === "boolean") node.isWideWidth = input.wide
      if (typeof input.authorVisible === "boolean") node.authorVisible = input.authorVisible
    }
    if (node.type === "SECTION" && typeof input.contentsHidden === "boolean") node.sectionContentsHidden = input.contentsHidden
    if (typeof input.name === "string") node.name = input.name
    if (input.sectionId) {
      var section = await getSection(input.sectionId)
      section.appendChild(node)
    }
    if (typeof input.x === "number") node.x = input.x
    if (typeof input.y === "number") node.y = input.y
    var wantW = typeof input.width === "number"
    var wantH = typeof input.height === "number"
    if ((wantW || wantH) && node.type !== "STICKY" && node.type !== "CONNECTOR") {
      var nw = wantW ? input.width : node.width
      var nh = wantH ? input.height : node.height
      if (node.type === "SECTION") node.resizeWithoutConstraints(nw, nh)
      else if (node.type === "TEXT") {
        if (wantW && !wantH) node.textAutoResize = "HEIGHT"
        else node.textAutoResize = "NONE"
        node.resize(nw, nh)
      } else if ("resize" in node) node.resize(nw, nh)
      else throw new Error(node.type + " can't be resized.")
    }
    if (typeof input.rotation === "number") {
      if (!("rotation" in node)) throw new Error(node.type + " can't be rotated.")
      rotateAboutCenter(node, input.rotation)
    }
    if (input.flipH || input.flipV) {
      if (node.type === "CONNECTOR" || !("relativeTransform" in node)) throw new Error(node.type + " can't be flipped.")
      try {
        node.relativeTransform = flipTransform(node.relativeTransform, node.width, node.height, Boolean(input.flipH), Boolean(input.flipV))
      } catch (error) {
        throw new Error(node.type + " can't be flipped here: " + errorText(error))
      }
    }
    if (typeof input.opacity === "number") node.opacity = Math.min(1, Math.max(0, input.opacity))
    if (typeof input.visible === "boolean") node.visible = input.visible
    if (input.lockMode) {
      if (node.type !== "SECTION") throw new Error("lockMode is for sections; use locked for other nodes.")
      var mode = oneOf(["ALL", "BACKGROUND", "NONE"], input.lockMode, "lockMode")
      node.locked = mode !== "NONE"
      for (var lk = 0; lk < node.children.length; lk++) node.children[lk].locked = mode === "ALL"
    }
    if (node.type === "SECTION" && input.fitToContents) fitSectionTight(node, input.padding)
    if (node.parent && node.parent.type === "SECTION") fitSection(node.parent)
    if (typeof input.locked === "boolean") node.locked = input.locked
    return withRamp(describe(node), input)
  })

function resolveFont(base, o) {
  var family = o.fontFamily || (base && base !== figma.mixed && base.family) || DEFAULT_FONT.family
  if (o.fontStyle) return { family: family, style: String(o.fontStyle) }
  var style = (base && base !== figma.mixed && base.style && !o.fontFamily) ? base.style : (family === "Inter" ? "Medium" : "Regular")
  var italic = /italic/i.test(style)
  var weight = style.replace(/\s*italic\s*/i, "").trim() || "Regular"
  if (o.bold === true) weight = "Bold"
  if (o.bold === false && /bold|black|heavy|semi/i.test(weight)) weight = family === "Inter" ? "Medium" : "Regular"
  if (typeof o.italic === "boolean") italic = o.italic
  return { family: family, style: italic ? (weight === "Regular" ? "Italic" : weight + " Italic") : weight }
}

// FigJam text sublayers can throw on properties they don't support.
function hasProp(target, key) {
  try {
    return typeof target[key] === "string"
  } catch (error) {
    return false
  }
}

function hasFontChange(o) {
  return Boolean(o.fontFamily || o.fontStyle || typeof o.bold === "boolean" || typeof o.italic === "boolean")
}

// Apply style options to characters [start, end) of a text target.
async function styleRange(t, start, end, o) {
  if (end <= start) return
  if (hasFontChange(o)) {
    var segs = t.getStyledTextSegments(["fontName"])
    for (var i = 0; i < segs.length; i++) {
      var s = Math.max(start, segs[i].start)
      var e = Math.min(end, segs[i].end)
      if (e <= s) continue
      var font = await loadFont(resolveFont(segs[i].fontName, o))
      t.setRangeFontName(s, e, font)
    }
  }
  if (typeof o.fontSize === "number") t.setRangeFontSize(start, end, o.fontSize)
  if (typeof o.lineHeight === "number") t.setRangeLineHeight(start, end, o.lineHeight > 0 ? { value: o.lineHeight, unit: "PIXELS" } : { unit: "AUTO" })
  if (typeof o.letterSpacing === "number") t.setRangeLetterSpacing(start, end, { value: o.letterSpacing, unit: "PERCENT" })
  if (o.textCase) t.setRangeTextCase(start, end, oneOf(["ORIGINAL", "UPPER", "LOWER", "TITLE"], o.textCase, "textCase"))
  if (o.color) t.setRangeFills(start, end, [solid(o.color)])
  if (typeof o.underline === "boolean" || typeof o.strikethrough === "boolean") {
    t.setRangeTextDecoration(start, end, o.underline ? "UNDERLINE" : o.strikethrough ? "STRIKETHROUGH" : "NONE")
  }
  if (typeof o.url === "string") t.setRangeHyperlink(start, end, o.url ? { type: "URL", value: o.url } : null)
}

function rangesFor(t, r) {
  var chars = t.characters
  if (typeof r.match === "string" && r.match) {
    var out = []
    var from = 0
    while (true) {
      var at = chars.indexOf(r.match, from)
      if (at < 0) break
      out.push([at, at + r.match.length])
      if (!r.all) break
      from = at + r.match.length
    }
    if (out.length === 0) throw new Error("Text \"" + r.match + "\" not found.")
    return out
  }
  var start = Math.max(0, Math.min(chars.length, Number(r.start) || 0))
  var end = typeof r.end === "number" ? Math.max(start, Math.min(chars.length, r.end)) : chars.length
  return [[start, end]]
}

var RANGE_PROPS = {}
Object.keys(TEXT_STYLE_PROPS).forEach(function (k) { RANGE_PROPS[k] = TEXT_STYLE_PROPS[k] })
RANGE_PROPS.start = int("First character (default 0).")
RANGE_PROPS.end = int("End character, exclusive (default: end of text).")
RANGE_PROPS.match = str("Style this substring instead of start/end.")
RANGE_PROPS.all = bool("With match: every occurrence (default first only).")

var STYLE_TEXT_PROPS = { id: str(), row: int("Table cell row (with col) when id is a table."), col: int() }
Object.keys(TEXT_STYLE_PROPS).forEach(function (k) { STYLE_TEXT_PROPS[k] = TEXT_STYLE_PROPS[k] })
STYLE_TEXT_PROPS.align = str("LEFT, CENTER, RIGHT, JUSTIFIED. Text nodes and shapes only (sticky text has no alignment API).")
STYLE_TEXT_PROPS.verticalAlign = str("TOP, CENTER, BOTTOM, where the node supports it.")
STYLE_TEXT_PROPS.list = str("Bullets for the whole text: UNORDERED, ORDERED or NONE.")
STYLE_TEXT_PROPS.lineHeight = num("Pixels (0 = auto).")
STYLE_TEXT_PROPS.letterSpacing = num("Percent.")
STYLE_TEXT_PROPS.ranges = arr(obj(RANGE_PROPS), "Styles for parts of the text, applied after the whole-text options.")

tool("style_text",
  "Style the text of a sticky, shape, connector label, text node or table cell: font family/style, bold/italic, size, color, underline/strikethrough, links, list bullets, line height, alignment (text nodes only), and per-range styles (by start/end or matching substring).",
  STYLE_TEXT_PROPS, ["id"],
  async function (input) {
    var node = await getNode(input.id)
    input = await resolveTextOptions(input, node.type)
    var t
    if (node.type === "TABLE") {
      if (typeof input.row !== "number" || typeof input.col !== "number") throw new Error("Pass row and col for a table cell.")
      t = node.cellAt(input.row, input.col).text
    } else t = textTarget(node)
    if (!t) throw new Error(node.type + " has no text to style.")
    await loadAllFonts(t)
    var len = t.characters.length
    if (len === 0 && hasFontChange(input)) {
      t.fontName = await loadFont(resolveFont(t.fontName, input))
    }
    await styleRange(t, 0, len, input)
    if (input.align) {
      if (!hasProp(t, "textAlignHorizontal")) throw new Error("FigJam doesn't expose text alignment on " + node.type + " text (TEXT nodes and shapes have it; stickies don't).")
      t.textAlignHorizontal = oneOf(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"], input.align, "align")
    }
    if (input.verticalAlign) {
      if (!hasProp(t, "textAlignVertical")) throw new Error("FigJam doesn't expose vertical alignment on " + node.type + " text.")
      t.textAlignVertical = oneOf(["TOP", "CENTER", "BOTTOM"], input.verticalAlign, "verticalAlign")
    }
    if (input.list && len > 0) t.setRangeListOptions(0, len, { type: oneOf(["UNORDERED", "ORDERED", "NONE"], input.list, "list") })
    if (typeof input.lineHeight === "number" && len > 0) t.setRangeLineHeight(0, len, input.lineHeight > 0 ? { value: input.lineHeight, unit: "PIXELS" } : { unit: "AUTO" })
    if (typeof input.letterSpacing === "number" && len > 0) t.setRangeLetterSpacing(0, len, { value: input.letterSpacing, unit: "PERCENT" })
    if (Array.isArray(input.ranges)) {
      for (var i = 0; i < input.ranges.length; i++) {
        var spans = rangesFor(t, input.ranges[i])
        var ro = await resolveTextOptions(input.ranges[i], node.type)
        for (var j = 0; j < spans.length; j++) await styleRange(t, spans[j][0], spans[j][1], ro)
      }
    }
    var d = describe(node)
    d.textStyle = textStyleOut(t)
    return withRamp(d, input)
  })

tool("set_link",
  "Add or remove a hyperlink on the text of a sticky, shape-with-text, connector label or text node. nodeId links to a node (works across pages); url links to a web page; neither removes the link. Default range is the whole text.",
  {
    id: str(),
    url: str(),
    nodeId: str("Link target node id (may be on another page)."),
    start: int(),
    end: int(),
    match: str("Link this substring instead of start/end."),
  }, ["id"],
  async function (input) {
    var node = await getNode(input.id)
    var t = textTarget(node)
    if (!t) throw new Error(node.type + " has no text to link. Link a sticky, shape, connector label or text node.")
    if (t.characters.length === 0) throw new Error("The text is empty; add text before linking it.")
    await loadAllFonts(t)
    var target = null
    if (input.nodeId) {
      var linked = await figma.getNodeByIdAsync(String(input.nodeId))
      if (!linked) throw new Error("No node with id " + input.nodeId + " in this file.")
      target = { type: "NODE", value: linked.id }
    } else if (input.url) target = { type: "URL", value: String(input.url) }
    var spans = rangesFor(t, input)
    for (var i = 0; i < spans.length; i++) t.setRangeHyperlink(spans[i][0], spans[i][1], target)
    var d = describe(node)
    d.link = linkOf(t) || null
    return d
  })

tool("delete_nodes", "Delete nodes by id. Only when the user asked for it.", { ids: IDS }, ["ids"],
  async function (input) {
    var ids = Array.isArray(input.ids) ? input.ids : []
    var deleted = []
    for (var i = 0; i < ids.length; i++) {
      var node = await getNode(ids[i])
      node.remove()
      deleted.push(String(ids[i]))
    }
    return { deleted: deleted }
  })

tool("duplicate",
  "Duplicate nodes (keeps them in the same section/group). Copies are offset by dx/dy (default: to the right of the set). Connectors whose two ends are both duplicated are re-attached to the copies.",
  { ids: IDS, dx: num(), dy: num() }, ["ids"],
  async function (input) {
    var nodes = await getNodes(input.ids, 100)
    var box = unionBox(nodes)
    var dx = typeof input.dx === "number" ? input.dx : box.width + GAP
    var dy = typeof input.dy === "number" ? input.dy : 0
    var map = {}
    var copies = []
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var b = bbox(n)
      var copy = n.clone()
      var parent = n.parent
      if (copy.parent !== parent) parent.insertChild(parent.children.indexOf(n) + 1, copy)
      if (copy.type !== "CONNECTOR") moveAbs(copy, b.x + dx, b.y + dy)
      map[n.id] = copy.id
      copies.push(copy)
    }
    // A copied connector: ends on copied nodes follow the copies, free ends
    // move with the offset, ends on other nodes stay put.
    function copyEnd(ep) {
      if (!ep) return ep
      if (isFloating(ep)) return ep.position ? { position: { x: ep.position.x + dx, y: ep.position.y + dy } } : ep
      if (map[ep.endpointNodeId]) return { endpointNodeId: map[ep.endpointNodeId], magnet: ep.magnet || "AUTO" }
      return ep
    }
    for (var k = 0; k < copies.length; k++) {
      var c = copies[k]
      if (c.type !== "CONNECTOR") continue
      c.connectorStart = copyEnd(c.connectorStart)
      c.connectorEnd = copyEnd(c.connectorEnd)
    }
    return { created: copies.map(describe), idMap: map }
  })

tool("group", "Group nodes (they must share a parent). Returns the group.", { ids: IDS, name: str() }, ["ids"],
  async function (input) {
    var nodes = await getNodes(input.ids, 200)
    var parent = nodes[0].parent
    for (var i = 1; i < nodes.length; i++) {
      if (nodes[i].parent !== parent) throw new Error("All nodes must share one parent; use move_to first.")
    }
    var g = figma.group(nodes, parent)
    if (input.name) g.name = String(input.name)
    return describe(g)
  })

tool("ungroup", "Ungroup a group, or remove a section and keep its contents (children move to the section's parent at the same board position, then the section is deleted). Returns the former children.", { id: str() }, ["id"],
  async function (input) {
    var g = await getNode(input.id)
    if (g.type === "SECTION") return { children: removeSectionKeepContents(g).map(describe), removed: g.id }
    if (g.type !== "GROUP") throw new Error("Node " + input.id + " is a " + g.type + ", not a GROUP or SECTION.")
    return { children: figma.ungroup(g).map(describe) }
  })

function removeSectionKeepContents(section) {
  var parent = section.parent
  var idx = parent.children.indexOf(section) + 1
  var kids = section.children.slice()
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i]
    var before = k.absoluteTransform
    parent.insertChild(idx++, k)
    var after = k.absoluteTransform
    k.x += before[0][2] - after[0][2]
    k.y += before[1][2] - after[1][2]
  }
  section.remove()
  return kids
}

tool("move_to",
  "Move nodes into a section or group, back onto the page (parentId \"page\"), or to another page (pageId or pageName: FigJam's Move to page; top level there, same board position). Moving to another page needs expect or confirm from remote agents. Connectors whose ends move to another page are reported in connectorsLeft (they stay on the old page).",
  {
    ids: IDS,
    parentId: str("Section or group id, or \"page\"."),
    pageId: str("Move to this page (Move to page)."),
    pageName: str("Or the target page's exact name."),
    keepPosition: bool("Keep page position (default true). False: use x/y relative to the new parent."),
    x: num(),
    y: num(),
  }, ["ids"],
  async function (input) {
    var nodes = await getNodes(input.ids, 200)
    if (input.pageId || input.pageName) return moveToPage(nodes, await getPage({ id: input.pageId, name: input.pageName }))
    if (!input.parentId) throw toolError("bad_input", "Pass parentId (section, group or \"page\"), or pageId/pageName to move to another page.")
    var parent
    if (input.parentId === "page" || input.parentId === activePage().id) parent = activePage()
    else {
      parent = await getNode(input.parentId)
      if (parent.type !== "SECTION" && parent.type !== "GROUP") throw new Error("Can only move into a SECTION, GROUP or the page, not a " + parent.type + ".")
    }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var b = bbox(n)
      parent.appendChild(n)
      if (input.keepPosition === false) {
        if (typeof input.x === "number") n.x = input.x
        if (typeof input.y === "number") n.y = input.y
      } else moveAbs(n, b.x, b.y)
    }
    if (parent.type === "SECTION") fitSection(parent)
    return { moved: nodes.map(describe) }
  })

async function moveToPage(nodes, page) {
  await page.loadAsync()
  var moved = []
  var unchanged = []
  var from = {}
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    var src = pageOf(n)
    if (src === page && n.parent === page) {
      unchanged.push(n.id)
      continue
    }
    if (src) from[src.id] = src
    var b = bbox(n)
    var oldParent = n.parent
    page.appendChild(n)
    moveAbs(n, b.x, b.y)
    if (oldParent && oldParent.type === "SECTION") fitSection(oldParent)
    moved.push(n)
  }
  var ids = {}
  moved.forEach(function (n) { ids[n.id] = true })
  var left = []
  Object.keys(from).forEach(function (pid) {
    if (from[pid] === page) return
    from[pid].findAllWithCriteria({ types: ["CONNECTOR"] }).forEach(function (c) {
      var a = c.connectorStart && c.connectorStart.endpointNodeId
      var z = c.connectorEnd && c.connectorEnd.endpointNodeId
      if (!ids[c.id] && (ids[a] || ids[z])) left.push(c.id)
    })
  })
  var out = { page: { id: page.id, name: page.name }, moved: moved.map(describe), changed: moved.length > 0 }
  if (unchanged.length) out.alreadyThere = unchanged
  if (left.length) out.connectorsLeft = left
  return out
}

tool("unlock_all",
  "FigJam's Unlock all objects: unlock every locked node on a page (default the current page) or inside one section (the section too). Returns the ids it unlocked (empty + changed: false when nothing was locked). Remote agents pass expect or confirm.",
  { pageId: str("Page to unlock (default current)."), sectionId: str("Only this section and its contents.") }, [],
  async function (input) {
    var root
    if (input.sectionId) root = await getSection(input.sectionId)
    else if (input.pageId) {
      root = await getPage({ id: input.pageId })
      await root.loadAsync()
    } else root = activePage()
    var locked = root.findAll(function (n) { return Boolean(n.locked) })
    if (root.type === "SECTION" && root.locked) locked.unshift(root)
    for (var i = 0; i < locked.length; i++) locked[i].locked = false
    var page = root.type === "PAGE" ? root : pageOf(root)
    return { ids: locked.map(function (n) { return n.id }), count: locked.length, changed: locked.length > 0, pageId: page ? page.id : undefined }
  })

tool("calibrate_fonts",
  "Learn the real fonts/sizes behind FigJam's toolbar presets. Ask the user to set a sticky/text in each toolbar font (Simple, Bookish, Technical, Scribbled) or size, then pass those nodes with the preset they show: reports each node's font family/style/size; with save: true the mapping is stored for this user (figma.clientStorage) and fontFamily/fontSize presets use it from then on. No samples: reports the mapping in use (learned, candidates, which candidates are installed). reset: true forgets learned values.",
  {
    samples: arr(obj({ id: str(), fontFamily: str("The toolbar font this node shows: simple, bookish, technical or scribbled."), fontSize: str("The toolbar size it shows: small, medium, large, extra large, huge.") }), "Nodes set by hand in FigJam."),
    save: bool("Store what the samples show."),
    reset: bool("Forget learned fonts and sizes first."),
  }, [],
  async function (input) {
    var mem = await fontMemory()
    if (input.reset) {
      mem.families = {}
      mem.sizes = {}
    }
    var read = []
    var samples = Array.isArray(input.samples) ? input.samples : []
    for (var i = 0; i < samples.length; i++) {
      var sm = samples[i]
      var node = await getNode(sm.id)
      var t = textTarget(node)
      if (!t) throw toolError("bad_input", node.type + " " + node.id + " has no text.")
      var font = t.fontName === figma.mixed ? (t.characters.length ? t.getRangeFontName(0, 1) : undefined) : t.fontName
      var size = t.fontSize === figma.mixed ? (t.characters.length ? t.getRangeFontSize(0, 1) : undefined) : t.fontSize
      var o = { id: node.id, type: node.type, family: font && font.family, style: font && font.style, fontSize: size }
      if (sm.fontFamily) {
        var key = presetKey(sm.fontFamily)
        if (!key) throw toolError("bad_input", "fontFamily must be simple, bookish, technical or scribbled.")
        o.fontPreset = key
        if (input.save && font && font.family) mem.families[key] = { family: font.family, style: font.style }
      }
      if (sm.fontSize) {
        var sk = sizeKey(sm.fontSize)
        if (!sk) throw toolError("bad_input", "fontSize must be small, medium, large, extra large or huge.")
        o.sizePreset = sk
        if (input.save && typeof size === "number") {
          mem.sizes[node.type] = mem.sizes[node.type] || {}
          mem.sizes[node.type][sk] = size
        }
      }
      read.push(o)
    }
    if (input.save || input.reset) await figma.clientStorage.setAsync(FONT_STORE_KEY, { families: mem.families, sizes: mem.sizes })
    var available = await fontList()
    var families = {}
    Object.keys(FONT_PRESETS).forEach(function (k) {
      var f = pickFamily(k, available, mem.families)
      families[k] = { uses: f.family, style: f.style, source: f.source, candidates: FONT_PRESETS[k].map(function (c) { return c.family + " " + c.style }) }
    })
    return { samples: read, saved: Boolean(input.save), families: families, sizes: SIZE_PRESETS, learnedSizes: mem.sizes }
  }, { readOnly: true })

tool("reorder", "Change stacking order within each node's parent: front, back, forward (one step) or backward.",
  { ids: IDS, to: str("front, back, forward or backward.") }, ["ids", "to"],
  async function (input) {
    var nodes = await getNodes(input.ids, 200)
    var to = String(input.to).toLowerCase()
    if (["front", "back", "forward", "backward"].indexOf(to) < 0) throw new Error("to must be front, back, forward or backward.")
    // Process in an order that keeps the set's relative stacking.
    nodes.sort(function (a, b) { return a.parent.children.indexOf(a) - b.parent.children.indexOf(b) })
    if (to === "forward" || to === "back") nodes.reverse()
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var p = n.parent
      var idx = p.children.indexOf(n)
      if (to === "front") p.appendChild(n)
      else if (to === "back") p.insertChild(0, n)
      // insertChild's index counts the node's current slot, so +2 moves up one.
      else if (to === "forward") { if (idx + 2 <= p.children.length) p.insertChild(idx + 2, n); else p.appendChild(n) }
      else if (idx > 0) p.insertChild(idx - 1, n)
    }
    return { order: nodes.map(function (n) { return { id: n.id, index: n.parent.children.indexOf(n), of: n.parent.children.length } }) }
  })

function movable(nodes) {
  return nodes.filter(function (n) { return n.type !== "CONNECTOR" })
}

tool("align", "Align nodes' edges or centers (page coordinates). Connectors are skipped (they follow their ends).",
  {
    ids: IDS,
    edge: str("left, right, top, bottom, centerX (vertical center line) or centerY."),
    toId: str("Align to this node instead of the set's bounds."),
  }, ["ids", "edge"],
  async function (input) {
    var nodes = movable(await getNodes(input.ids, 200))
    var ref = input.toId ? bbox(await getNode(input.toId)) : unionBox(nodes)
    var edge = String(input.edge)
    for (var i = 0; i < nodes.length; i++) {
      var b = bbox(nodes[i])
      var x = b.x
      var y = b.y
      if (edge === "left") x = ref.x
      else if (edge === "right") x = ref.x + ref.width - b.width
      else if (edge === "centerX") x = ref.x + ref.width / 2 - b.width / 2
      else if (edge === "top") y = ref.y
      else if (edge === "bottom") y = ref.y + ref.height - b.height
      else if (edge === "centerY") y = ref.y + ref.height / 2 - b.height / 2
      else throw new Error("edge must be left, right, top, bottom, centerX or centerY.")
      moveAbs(nodes[i], x, y)
    }
    return { aligned: nodes.map(describe) }
  })

tool("distribute",
  "Space nodes evenly along an axis, keeping the first and last in place, or with a fixed gap from the first.",
  { ids: IDS, axis: str("horizontal or vertical."), gap: num("Fixed gap instead of even spacing.") }, ["ids", "axis"],
  async function (input) {
    var nodes = movable(await getNodes(input.ids, 200))
    if (nodes.length < 2) throw new Error("Need at least two nodes.")
    var horiz = String(input.axis).toLowerCase().charAt(0) === "h"
    nodes.sort(function (a, b) { return horiz ? bbox(a).x - bbox(b).x : bbox(a).y - bbox(b).y })
    var boxes = nodes.map(bbox)
    var gap = input.gap
    if (typeof gap !== "number") {
      var first = boxes[0]
      var last = boxes[boxes.length - 1]
      var span = horiz ? last.x + last.width - first.x : last.y + last.height - first.y
      var total = 0
      for (var i = 0; i < boxes.length; i++) total += horiz ? boxes[i].width : boxes[i].height
      gap = (span - total) / (nodes.length - 1)
    }
    var pos = horiz ? boxes[0].x : boxes[0].y
    for (var k = 0; k < nodes.length; k++) {
      if (horiz) moveAbs(nodes[k], pos, boxes[k].y)
      else moveAbs(nodes[k], boxes[k].x, pos)
      pos += (horiz ? boxes[k].width : boxes[k].height) + gap
    }
    return { gap: round(gap), nodes: nodes.map(describe) }
  })

tool("arrange_grid",
  "Lay out any nodes in a grid using their real sizes, in the order given. Origin defaults to the set's current top-left (page coordinates).",
  { ids: IDS, columns: int("Default: roughly square."), gap: num("Default 64."), x: num("Page x of the grid."), y: num("Page y of the grid.") }, ["ids"],
  async function (input) {
    var nodes = movable(await getNodes(input.ids, 400))
    var box = unionBox(nodes)
    var ox = typeof input.x === "number" ? input.x : box.x
    var oy = typeof input.y === "number" ? input.y : box.y
    var g = typeof input.gap === "number" ? input.gap : GAP
    var cols = Math.max(1, Number(input.columns) || Math.ceil(Math.sqrt(nodes.length)))
    var y = oy
    for (var r = 0; r * cols < nodes.length; r++) {
      var row = nodes.slice(r * cols, r * cols + cols)
      var x = ox
      var rowH = 0
      for (var i = 0; i < row.length; i++) {
        var b = bbox(row[i])
        moveAbs(row[i], x, y)
        x += b.width + g
        rowH = Math.max(rowH, b.height)
      }
      y += rowH + g
    }
    var sections = []
    for (var k = 0; k < nodes.length; k++) {
      var p = nodes[k].parent
      if (p.type === "SECTION" && sections.indexOf(p) < 0) sections.push(p)
    }
    sections.forEach(fitSection)
    return { arranged: nodes.map(describe) }
  })

// ------------------------------------------------------------------ tools: view

tool("focus", "Select the given nodes and zoom the user's view to them.", { ids: IDS }, ["ids"],
  async function (input) {
    var nodes = []
    var ids = Array.isArray(input.ids) ? input.ids : []
    for (var i = 0; i < ids.length; i++) nodes.push(await getNode(ids[i]))
    if (nodes.length === 0) return { focused: [] }
    figma.currentPage.selection = nodes
    figma.viewport.scrollAndZoomIntoView(nodes)
    return { focused: nodes.map(function (n) { return n.id }) }
  }, { readOnly: true })

// Color key of a node: first solid fill (strokes for connectors/vectors).
function nodePaints(node) {
  if (node.type === "CONNECTOR" || node.type === "VECTOR" || node.type === "HIGHLIGHT") return node.strokes
  return node.fills
}
function paletteFor(node) {
  return { STICKY: STICKY, SECTION: SECTION, SHAPE_WITH_TEXT: SHAPE, TABLE: TABLE, CONNECTOR: CONNECTOR }[node.type]
}

// Does a node satisfy {type?, color?, shape?, author?}? color is hex or a
// palette name for the node's own type.
function matchNode(node, crit) {
  if (crit.type && node.type !== String(crit.type).toUpperCase()) return false
  if (crit.shape && node.shapeType !== String(crit.shape).toUpperCase()) return false
  if (crit.author !== undefined && crit.author !== null && String(node.authorName || "").toLowerCase() !== String(crit.author).toLowerCase()) return false
  if (crit.color) {
    var c = solidColor(nodePaints(node))
    if (!c) return false
    if (isHex(crit.color)) {
      if (hex(c) !== hex(parseHex(crit.color).color)) return false
    } else {
      var pal = paletteFor(node)
      if (!pal || String(colorName(pal, nodePaints(node))).toLowerCase() !== String(crit.color).toLowerCase()) return false
    }
  }
  return true
}

tool("select", "Set the selection without moving the view. Either ids (empty clears it) or match: select matching nodes (same type / fill color / shape type / author as a reference node via sameAs + by, or explicit type/color/shape/author), optionally only inside a section; match {all: true} alone = select all top-level nodes on the page (or all in inSectionId). Returns the selected ids.",
  {
    ids: IDS,
    match: obj({
      sameAs: str("Reference node id."),
      by: arr(str(), "With sameAs: which of type, color, shape, author to match (default [\"type\"])."),
      type: str("Node type, e.g. STICKY, SHAPE_WITH_TEXT, CONNECTOR."),
      color: str("Hex, or palette name for the node's type (e.g. yellow)."),
      shape: str("Shape type, e.g. DIAMOND."),
      author: str("Sticky author name."),
      inSectionId: str("Only within this section."),
      all: bool("No filters: everything (top-level on the page, or all inside inSectionId)."),
    }, "Select by criteria instead of ids."),
  }, [],
  async function (input) {
    var nodes = []
    if (input.match) {
      var m = input.match
      var crit = { type: m.type, color: m.color, shape: m.shape, author: m.author }
      if (m.sameAs) {
        var ref = await getNode(m.sameAs)
        var by = Array.isArray(m.by) && m.by.length ? m.by : ["type"]
        by.forEach(function (k) {
          k = String(k).toLowerCase()
          if (k === "type") crit.type = ref.type
          else if (k === "color") { var rc = solidColor(nodePaints(ref)); if (!rc) throw new Error("Reference node has no solid color."); crit.color = hex(rc) }
          else if (k === "shape") crit.shape = ref.shapeType
          else if (k === "author") crit.author = ref.authorName || ""
          else throw new Error("Unknown match.by \"" + k + "\". Use type, color, shape, author.")
        })
      }
      var filtered = crit.type || crit.color || crit.shape || (crit.author !== undefined && crit.author !== null)
      if (!filtered && !m.all) throw new Error("match needs sameAs, a filter (type/color/shape/author) or all: true.")
      var scope = m.inSectionId ? await getSection(m.inSectionId) : figma.currentPage
      var pool = filtered || m.inSectionId ? scope.findAll() : scope.children.slice()
      nodes = pool.filter(function (n) { return matchNode(n, crit) })
    } else {
      var ids = Array.isArray(input.ids) ? input.ids : []
      for (var i = 0; i < ids.length; i++) nodes.push(await getNode(ids[i]))
    }
    figma.currentPage.selection = nodes
    var out = nodes.map(function (n) { return n.id })
    return { selected: out.slice(0, 400), count: out.length }
  }, { readOnly: true })

function viewportOut() {
  var v = figma.viewport
  return { center: { x: Math.round(v.center.x), y: Math.round(v.center.y) }, zoom: round(v.zoom), bounds: viewportBounds() }
}

tool("viewport",
  "Read or move the user's view: zoom to node ids or a page rect, or set center/zoom. With no arguments, returns the current center, zoom and visible bounds.",
  {
    ids: IDS,
    rect: obj({ x: num(), y: num(), width: num(), height: num() }, "Page rectangle to fit on screen."),
    center: obj(POINT),
    zoom: num("1 = 100%."),
  }, [],
  async function (input) {
    try {
      void figma.viewport.zoom
    } catch (error) {
      return { available: false, error: "No viewport in this runtime: " + errorText(error) }
    }
    if (Array.isArray(input.ids) && input.ids.length) figma.viewport.scrollAndZoomIntoView(await getNodes(input.ids, 400))
    else if (input.rect && input.rect.width > 0 && input.rect.height > 0) {
      var v = figma.viewport
      var screenW = v.bounds.width * v.zoom
      var screenH = v.bounds.height * v.zoom
      figma.viewport.center = { x: input.rect.x + input.rect.width / 2, y: input.rect.y + input.rect.height / 2 }
      figma.viewport.zoom = Math.min(screenW / (input.rect.width * 1.1), screenH / (input.rect.height * 1.1))
    }
    if (input.center && typeof input.center.x === "number") figma.viewport.center = { x: input.center.x, y: input.center.y }
    if (typeof input.zoom === "number" && input.zoom > 0) figma.viewport.zoom = input.zoom
    return viewportOut()
  }, { readOnly: true })

// ------------------------------------------------------------------ tools: export

var MAX_EXPORT_BYTES = 12 * 1024 * 1024

async function exportOne(target, box, input, label) {
  var fmt = String(input.format || "PNG").toUpperCase()
  if (fmt === "SVG") {
    var svg = await target.exportAsync({ format: "SVG_STRING" })
    if (svg.length > MAX_EXPORT_BYTES) throw new Error("SVG of " + label + " is " + svg.length + " characters; export fewer nodes.")
    return { id: label, format: "SVG", width: Math.round(box.width), height: Math.round(box.height), bytes: svg.length, svg: svg }
  }
  if (fmt !== "PNG" && fmt !== "JPG") throw new Error("format must be PNG, JPG or SVG.")
  var maxDim = Math.min(Math.max(Number(input.maxDimension) || 2048, 16), 4096)
  var scale = Math.min(Math.max(Number(input.scale) || 1, 0.01), 4)
  var longest = Math.max(box.width, box.height, 1)
  if (longest * scale > maxDim) scale = maxDim / longest
  var bytes = await target.exportAsync({ format: fmt, constraint: { type: "SCALE", value: scale } })
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error("Export of " + label + " is " + bytes.length + " bytes; lower maxDimension or scale.")
  return {
    id: label,
    format: fmt,
    width: Math.round(box.width * scale),
    height: Math.round(box.height * scale),
    scale: round(scale),
    bytes: bytes.length,
    base64: figma.base64Encode(bytes),
  }
}

// Export a page rectangle by dropping a temporary slice over it.
async function exportRect(rect, input, label) {
  var slice = figma.createSlice()
  try {
    activePage().appendChild(slice)
    slice.x = rect.x
    slice.y = rect.y
    slice.resize(Math.max(1, rect.width), Math.max(1, rect.height))
    return await exportOne(slice, rect, input, label)
  } finally {
    slice.remove()
  }
}

tool("export_png",
  "Render nodes, a page rectangle, or the whole current page to PNG/JPG for a visual check, or to SVG markup. PNG/JPG come back as base64 (the bridge saves them under exports/ and returns the file path instead); SVG comes back as `svg` text. Bounded by maxDimension. Nothing goes to the clipboard (plugins have no clipboard access).",
  {
    ids: arr(str(), "Export each node separately (max 10)."),
    combine: bool("With ids: one image of the area covering all of them."),
    rect: obj({ x: num(), y: num(), width: num(), height: num() }, "Page rectangle to render."),
    padding: num("Extra margin around combined/rect exports (default 0)."),
    scale: num("Default 1 (max 4)."),
    maxDimension: num("Longest side in pixels (default 2048, max 4096)."),
    format: str("PNG (default), JPG, or SVG (returned inline as `svg` text; not written to exports/)."),
  }, [],
  async function (input) {
    var images = []
    var pad = Number(input.padding) || 0
    if (Array.isArray(input.ids) && input.ids.length) {
      var nodes = await getNodes(input.ids, 10)
      if (input.combine) {
        var u = unionBox(nodes)
        images.push(await exportRect({ x: u.x - pad, y: u.y - pad, width: u.width + 2 * pad, height: u.height + 2 * pad }, input, "combined"))
      } else {
        for (var i = 0; i < nodes.length; i++) images.push(await exportOne(nodes[i], bbox(nodes[i]), input, nodes[i].id))
      }
    } else if (input.rect) {
      var r = input.rect
      images.push(await exportRect({ x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }, input, "rect"))
    } else {
      var kids = activePage().children
      if (kids.length === 0) throw new Error("The page is empty.")
      var box = unionBox(kids)
      try {
        images.push(await exportOne(activePage(), box, input, "page"))
      } catch (error) {
        images.push(await exportRect(box, input, "page"))
      }
    }
    return { images: images }
  }, { readOnly: true })

// ------------------------------------------------------------------ tools: convert, copy_style, sort_stickies
//
// Context-menu actions FigJam has no plugin API for, rebuilt from primitives.
// Not possible from a plugin: clipboard (copy/paste/paste here), native
// FigJam AI actions (our model does them), creating native stamps/washi
// tape/pen strokes, comments (the comment tools use the REST API instead).

// Closest palette entry by RGB distance.
function nearestName(palette, c, keys) {
  var best
  var bestD = Infinity
  ;(keys || Object.keys(palette)).forEach(function (k) {
    var p = palette[k].fill || palette[k]
    var d = (p.r - c.r) * (p.r - c.r) + (p.g - c.g) * (p.g - c.g) + (p.b - c.b) * (p.b - c.b)
    if (d < bestD) { bestD = d; best = k }
  })
  return best
}

var COLOR_ALIASES = { black: "gray", darkGray: "gray", lightGray: "gray" }

// Translate a node's color between palettes (sticky ↔ shape ↔ table): same
// name when both have it, black/grays → gray, else nearest by RGB.
function mapColorName(fromPalette, toPalette, paints) {
  var c = solidColor(paints)
  if (!c) return undefined
  var name = fromPalette ? colorName(fromPalette, paints) : "custom"
  if (name && name !== "custom") {
    if (toPalette[name]) return name
    if (COLOR_ALIASES[name] && toPalette[COLOR_ALIASES[name]]) return COLOR_ALIASES[name]
  }
  return nearestName(toPalette, c, toPalette === SHAPE ? SHAPE_BASE_KEYS : undefined)
}

function insertAfter(old, node) {
  var parent = old.parent
  parent.insertChild(parent.children.indexOf(old) + 1, node)
}

function centerOn(node, box) {
  moveAbs(node, box.x + box.width / 2 - node.width / 2, box.y + box.height / 2 - node.height / 2)
}

// Point every connector end attached to oldId at newId (same magnet when allowed).
function reattachConnectors(oldId, newId) {
  var count = 0
  var conns = activePage().findAll(function (n) { return n.type === "CONNECTOR" })
  conns.forEach(function (c) {
    ;["connectorStart", "connectorEnd"].forEach(function (key) {
      var ep = c[key]
      if (!ep || isFloating(ep) || ep.endpointNodeId !== oldId) return
      try {
        c[key] = { endpointNodeId: newId, magnet: ep.magnet || "AUTO" }
      } catch (error) {
        try {
          c[key] = { endpointNodeId: newId, magnet: "AUTO" }
        } catch (error2) {
          return // this node type can't take connectors; the end goes with the original
        }
      }
      count++
    })
  })
  return count
}

function nodesInReadingOrder(nodes) {
  return readingOrder(nodes.map(function (n) { return { node: n, b: bbox(n) } })).map(function (it) { return it.node })
}

function urlOf(node) {
  if (node.type === "LINK_UNFURL" && node.linkUnfurlData) return node.linkUnfurlData.url
  if (node.type === "EMBED" && node.embedData) return node.embedData.srcUrl
  if (node.type === "TEXT") {
    var link = node.hyperlink
    if (link && link !== figma.mixed && link.type === "URL") return link.value
    var t = String(node.characters || "").trim()
    if (/^https?:\/\/\S+$/i.test(t)) return t
  }
  return undefined
}

async function setNodeText(node, text) {
  var t = textTarget(node)
  await loadTextFont(t)
  t.characters = text
}

// Make the single-node replacement for `old` (not yet placed).
async function makeConverted(old, to, input) {
  var text = textOf(old) || ""
  var n
  if (to === "STICKY") {
    n = figma.createSticky()
    var sc = input.color || (old.type === "SHAPE_WITH_TEXT" ? mapColorName(SHAPE, STICKY, old.fills) : "yellow")
    n.fills = [solid(sc, STICKY)]
    await setNodeText(n, text)
    if (text.length > 80) n.isWideWidth = true
  } else if (to === "SHAPE") {
    n = figma.createShapeWithText()
    n.shapeType = input.shape ? oneOf(SHAPES, input.shape, "shape") : "SQUARE"
    var shc = input.color || (old.type === "STICKY" ? mapColorName(STICKY, SHAPE, old.fills) : "white")
    n.resize(Math.max(old.width, 120), Math.max(old.height, 60))
    await setNodeText(n, text)
    applyShapeColors(n, { color: shc })
  } else if (to === "TEXT") {
    n = figma.createText()
    await figma.loadFontAsync(DEFAULT_FONT)
    n.fontName = DEFAULT_FONT
    var url = urlOf(old)
    if (old.type === "LINK_UNFURL" || old.type === "EMBED") {
      var title = (old.linkUnfurlData && old.linkUnfurlData.title) || url || ""
      n.characters = title
      if (url && title) n.setRangeHyperlink(0, title.length, { type: "URL", value: url })
    } else {
      n.characters = text
      var src = textTarget(old)
      if (src && typeof src.fontSize === "number") n.fontSize = src.fontSize
    }
    n.fills = [{ type: "SOLID", color: CHARCOAL }]
  } else if (to === "LINK") {
    var u = urlOf(old)
    if (!u) throw new Error("Node " + old.id + " has no URL to unfurl (needs a text link or a URL as its text).")
    if (typeof figma.createLinkPreviewAsync !== "function") throw new Error("This Figma version has no createLinkPreviewAsync.")
    n = await figma.createLinkPreviewAsync(u)
  } else throw new Error("Unsupported target " + to)
  return n
}

async function replaceNode(old, n) {
  var box = bbox(old)
  insertAfter(old, n)
  centerOn(n, box)
  var re = reattachConnectors(old.id, n.id)
  var oldId = old.id
  old.remove()
  return { from: oldId, id: n.id, type: n.type, reattached: re }
}

var CONVERTIBLE = { STICKY: true, SHAPE_WITH_TEXT: true, TEXT: true, LINK_UNFURL: true, EMBED: true }

tool("convert_node",
  "Convert nodes in place (FigJam's convert / quick-action menu, rebuilt: the API has no convert). to: STICKY, SHAPE or TEXT (between stickies, shapes-with-text and text: keeps text, center position and parent; sticky↔shape colors map to the nearest palette color; connectors are re-attached to the new node; the original is deleted), TABLE (stickies → one table, one row per sticky in reading order; columns pick text/author/color), STICKIES (table → one sticky per non-empty cell, laid out like the table), LINK (text URL → link preview; Figma decides card vs embed by provider, so card↔embed can't be forced), TEXT from a link preview/embed (title as a text link). replaceWith: swap each node for a copy of that node at the same center/size (\"paste to replace\", no clipboard). Destructive (originals are removed unless keepOriginals): needs expect or confirm. Returns converted [{from, id, type, reattached}], created, replaced.",
  {
    ids: IDS,
    to: str("STICKY, SHAPE, TEXT, TABLE, STICKIES or LINK."),
    shape: str("to SHAPE: shape type (default SQUARE)."),
    color: str("Palette name for the new node(s) instead of the mapped color."),
    replaceWith: str("Instead of to: id of a node to copy in place of each node in ids."),
    columns: arr(str(), "to TABLE: fields per row, from text, author, color (default [text])."),
    header: bool("to TABLE: add a header row of field names (default true). to STICKIES: include row 0 (default false)."),
    keepOriginals: bool("to TABLE / STICKIES: keep the source nodes."),
  }, ["ids"],
  async function (input) {
    var nodes = await getNodes(input.ids, 200)
    var converted = []
    var created = []
    if (input.replaceWith) {
      var source = await getNode(input.replaceWith)
      for (var r = 0; r < nodes.length; r++) {
        var target = nodes[r]
        if (target.id === source.id) continue
        var copy = source.clone()
        if (copy.type !== "STICKY" && copy.type !== "CONNECTOR" && "resize" in copy) {
          try {
            if (copy.type === "SECTION") copy.resizeWithoutConstraints(target.width, target.height)
            else copy.resize(target.width, target.height)
          } catch (error) { /* keep the source size */ }
        }
        var rr = await replaceNode(target, copy)
        converted.push(rr)
        created.push(describe(copy))
      }
      return { converted: converted, created: created, replaced: converted.map(function (c) { return c.from }) }
    }
    var to = oneOf(["STICKY", "SHAPE", "SHAPE_WITH_TEXT", "TEXT", "TABLE", "STICKIES", "LINK"], input.to, "to")
    if (to === "SHAPE_WITH_TEXT") to = "SHAPE"
    if (to === "TABLE") {
      var fields = Array.isArray(input.columns) && input.columns.length ? input.columns.map(function (f) { return oneOf(["TEXT", "AUTHOR", "COLOR"], f, "column").toLowerCase() }) : ["text"]
      var ordered = nodesInReadingOrder(nodes)
      var header = input.header !== false
      var table = figma.createTable(ordered.length + (header ? 1 : 0), fields.length)
      var box = unionBox(ordered)
      insertAfter(ordered[ordered.length - 1], table)
      moveAbs(table, box.x, box.y)
      var rows = []
      if (header) rows.push(fields.map(function (f) { return f.charAt(0).toUpperCase() + f.slice(1) }))
      ordered.forEach(function (n) {
        rows.push(fields.map(function (f) {
          if (f === "text") return textOf(n) || ""
          if (f === "author") return n.authorName || ""
          var pal = paletteFor(n)
          return pal ? colorName(pal, n.fills) || "" : ""
        }))
      })
      for (var tr = 0; tr < rows.length; tr++) {
        for (var tc = 0; tc < fields.length; tc++) {
          var cellText = table.cellAt(tr, tc).text
          await loadTextFont(cellText)
          cellText.characters = String(rows[tr][tc])
        }
      }
      if (!input.keepOriginals) ordered.forEach(function (n) { reattachConnectors(n.id, table.id); n.remove() })
      return { converted: [{ from: ordered.map(function (n) { return n.id }), id: table.id, type: "TABLE" }], created: [describe(table)], replaced: input.keepOriginals ? [] : ordered.map(function (n) { return n.id }) }
    }
    if (to === "STICKIES") {
      for (var ti = 0; ti < nodes.length; ti++) {
        var tbl = nodes[ti]
        if (tbl.type !== "TABLE") throw new Error("Node " + tbl.id + " is a " + tbl.type + "; to STICKIES needs a TABLE.")
        var tb = bbox(tbl)
        var made = []
        var first = input.header === true ? 0 : 1
        for (var row = first; row < tbl.numRows; row++) {
          for (var col = 0; col < tbl.numColumns; col++) {
            var txt = tbl.cellAt(row, col).text.characters
            if (!String(txt).trim()) continue
            var st = figma.createSticky()
            st.fills = [solid(input.color || "yellow", STICKY)]
            await setNodeText(st, txt)
            insertAfter(tbl, st)
            moveAbs(st, tb.x + col * (st.width + 24), tb.y + (row - first) * (st.height + 24))
            made.push(st)
          }
        }
        var tid = tbl.id
        if (!input.keepOriginals) tbl.remove()
        converted.push({ from: tid, ids: made.map(function (m) { return m.id }), type: "STICKY" })
        made.forEach(function (m) { created.push(describe(m)) })
      }
      return { converted: converted, created: created, replaced: input.keepOriginals ? [] : converted.map(function (c) { return c.from }) }
    }
    for (var i = 0; i < nodes.length; i++) {
      var old = nodes[i]
      if (!CONVERTIBLE[old.type]) throw new Error("Node " + old.id + " is a " + old.type + "; convert_node handles stickies, shapes, text, link previews and embeds (and tables with to STICKIES).")
      var want = to === "SHAPE" ? "SHAPE_WITH_TEXT" : to === "LINK" ? null : to
      if (want && old.type === want) continue
      var n = await makeConverted(old, to, input)
      var res = await replaceNode(old, n)
      converted.push(res)
      created.push(describe(n))
    }
    return { converted: converted, created: created, replaced: converted.map(function (c) { return c.from }) }
  })

var STYLE_PROPS = ["fill", "stroke", "strokeWeight", "dashPattern", "opacity", "cornerRadius", "shape", "wide", "font", "fontSize", "textColor", "textAlign", "connector"]

function usable(v) {
  return v !== undefined && v !== figma.mixed
}

// Apply one style property from src to dst; returns null or a skip reason.
async function copyStyleProp(src, dst, prop) {
  var sT = textTarget(src)
  var dT = textTarget(dst)
  var conn = src.type === "CONNECTOR" || dst.type === "CONNECTOR"
  switch (prop) {
    case "fill":
      if (conn) return "connectors have no fill"
      if (!("fills" in src) || !("fills" in dst) || !usable(src.fills)) return "no fill on one side"
      var dPal = dst.type === "STICKY" ? STICKY : dst.type === "SECTION" ? SECTION : null
      if (dPal && src.type !== dst.type) {
        var name = mapColorName(paletteFor(src), dPal, src.fills)
        if (!name) return "source has no solid fill"
        dst.fills = [solid(name, dPal)]
      } else dst.fills = JSON.parse(JSON.stringify(src.fills))
      return null
    case "stroke":
      if (conn && src.type !== dst.type) return "connector stroke only copies to connectors"
      if (!("strokes" in src) || !("strokes" in dst) || !usable(src.strokes)) return "no stroke on one side"
      dst.strokes = JSON.parse(JSON.stringify(src.strokes))
      return null
    case "strokeWeight": case "dashPattern": case "opacity": case "cornerRadius":
      if (!(prop in src) || !(prop in dst) || !usable(src[prop])) return "not supported by " + (prop in src ? dst.type : src.type)
      dst[prop] = Array.isArray(src[prop]) ? src[prop].slice() : src[prop]
      return null
    case "shape":
      if (src.type !== "SHAPE_WITH_TEXT" || dst.type !== "SHAPE_WITH_TEXT") return "only between shapes"
      dst.shapeType = src.shapeType
      return null
    case "wide":
      if (src.type !== "STICKY" || dst.type !== "STICKY") return "only between stickies"
      dst.isWideWidth = src.isWideWidth
      return null
    case "font": case "fontSize": case "textColor": case "textAlign":
      if (!sT || !dT) return "no text on one side"
      var key = { font: "fontName", fontSize: "fontSize", textColor: "fills", textAlign: "textAlignHorizontal" }[prop]
      if (!usable(sT[key])) return "source has mixed " + prop
      if (!(key in dT)) return "not supported by " + dst.type
      await loadTextFont(dT)
      if (prop === "font") await figma.loadFontAsync(sT.fontName)
      dT[key] = typeof sT[key] === "object" ? JSON.parse(JSON.stringify(sT[key])) : sT[key]
      return null
    case "connector":
      if (src.type !== "CONNECTOR" || dst.type !== "CONNECTOR") return "only between connectors"
      dst.connectorLineType = src.connectorLineType
      dst.strokes = JSON.parse(JSON.stringify(src.strokes))
      dst.strokeWeight = src.strokeWeight
      if (Array.isArray(src.dashPattern)) dst.dashPattern = src.dashPattern.slice()
      dst.connectorStartStrokeCap = src.connectorStartStrokeCap
      dst.connectorEndStrokeCap = src.connectorEndStrokeCap
      return null
  }
  return "unknown property"
}

tool("copy_style",
  "Copy properties from one node to others (FigJam's copy/paste properties, node to node; plugins have no clipboard). props (default all): fill (sticky/section targets get the nearest palette color), stroke, strokeWeight, dashPattern, opacity, cornerRadius, shape (shape type), wide (sticky), font, fontSize, textColor, textAlign, connector (line type, color, weight, dashes, caps). Only properties both nodes support are copied; each target reports applied and skipped [{prop, reason}].",
  {
    fromId: str("Source node."),
    toIds: arr(str(), "Target node ids."),
    props: arr(str(), "Subset of: " + STYLE_PROPS.join(", ") + "."),
  }, ["fromId", "toIds"],
  async function (input) {
    var src = await getNode(input.fromId)
    var targets = await getNodes(input.toIds, 200)
    var props = Array.isArray(input.props) && input.props.length ? input.props.map(function (p) {
      var k = STYLE_PROPS.filter(function (s) { return s.toLowerCase() === String(p).toLowerCase() })[0]
      if (!k) throw new Error("Unknown prop \"" + p + "\". Use: " + STYLE_PROPS.join(", "))
      return k
    }) : STYLE_PROPS
    var results = []
    for (var i = 0; i < targets.length; i++) {
      var dst = targets[i]
      var applied = []
      var skipped = []
      for (var j = 0; j < props.length; j++) {
        var reason
        try {
          reason = await copyStyleProp(src, dst, props[j])
        } catch (error) {
          reason = errorText(error)
        }
        if (reason) skipped.push({ prop: props[j], reason: reason })
        else applied.push(props[j])
      }
      if (dst.parent && dst.parent.type === "SECTION") fitSection(dst.parent)
      results.push({ id: dst.id, applied: applied, skipped: skipped })
    }
    return { results: results }
  })

var STICKY_ORDER = Object.keys(STICKY)

// Group sticky facts {id, color, author, text} for sort_stickies.
// color: palette order (custom last); author: alphabetical (no author last);
// text: one alphabetical group. Within color/author groups, input order is kept.
function groupStickies(items, by, groups) {
  function alpha(a, b) { return String(a.text || "").localeCompare(String(b.text || ""), undefined, { numeric: true, sensitivity: "base" }) }
  if (by === "text") return [{ label: null, ids: items.slice().sort(alpha).map(function (i) { return i.id }) }]
  if (by === "groups") {
    var known = {}
    items.forEach(function (i) { known[i.id] = true })
    var used = {}
    var out = (groups || []).map(function (g) {
      var ids = (g.ids || []).filter(function (id) { if (!known[id] || used[id]) return false; used[id] = true; return true })
      return { label: g.label === undefined ? g.title : g.label, ids: ids }
    }).filter(function (g) { return g.ids.length })
    var rest = items.filter(function (i) { return !used[i.id] }).map(function (i) { return i.id })
    if (rest.length) out.push({ label: "Other", ids: rest })
    return out
  }
  var key = by === "author" ? function (i) { return i.author || "" } : function (i) { return i.color || "custom" }
  var map = {}
  var keys = []
  items.forEach(function (i) {
    var k = key(i)
    if (!map[k]) { map[k] = []; keys.push(k) }
    map[k].push(i.id)
  })
  keys.sort(function (a, b) {
    if (by === "author") {
      if (!a || !b) return !a ? 1 : -1
      return a.localeCompare(b, undefined, { sensitivity: "base" })
    }
    var ia = STICKY_ORDER.indexOf(a)
    var ib = STICKY_ORDER.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
  return keys.map(function (k) {
    var label = by === "author" ? (k || "No author") : k.charAt(0).toUpperCase() + k.slice(1)
    return { label: label, ids: map[k] }
  })
}

tool("sort_stickies",
  "Sort and arrange stickies (FigJam's sort by color/author and AI sort/cluster, rebuilt; the native AI command isn't callable). Pick stickies by ids or sectionId; by: color (palette order), author, text (alphabetical grid), or groups: [{label, ids}] that you (the model) clustered from get_selection/board_tree — unlisted stickies go to \"Other\". Lays groups out as columns (wrapping after maxPerColumn) from the stickies' current top-left (or the section's), with a text header per column unless headers is false. One undo step. Returns groups [{label, ids, headerId}].",
  {
    ids: IDS,
    sectionId: str("Sort the stickies directly inside this section."),
    by: str("color, author, text or groups."),
    groups: arr(obj({ label: str(), ids: arr(str()) }), "by groups: the clusters, in column order."),
    headers: bool("Header text above each column (default true; never for by text)."),
    maxPerColumn: int("Stickies per column before wrapping (default 6)."),
    gap: num("Gap between stickies (default 24)."),
  }, [],
  async function (input) {
    var by = oneOf(["COLOR", "AUTHOR", "TEXT", "GROUPS"], input.by || (input.groups ? "groups" : "color"), "by").toLowerCase()
    var stickies
    var section = null
    if (input.sectionId) {
      section = await getSection(input.sectionId)
      stickies = section.children.filter(function (n) { return n.type === "STICKY" })
      if (Array.isArray(input.ids) && input.ids.length) stickies = stickies.filter(function (n) { return input.ids.indexOf(n.id) >= 0 })
    } else stickies = (await getNodes(input.ids, 500)).filter(function (n) { return n.type === "STICKY" })
    if (!stickies.length) throw new Error("No stickies to sort (pass ids or a sectionId that contains stickies).")
    stickies = nodesInReadingOrder(stickies)
    var byId = {}
    var items = stickies.map(function (n) {
      byId[n.id] = n
      return { id: n.id, color: colorName(STICKY, n.fills), author: n.authorName || "", text: textOf(n) || "" }
    })
    var groups = groupStickies(items, by, input.groups)
    var gap = typeof input.gap === "number" ? input.gap : 24
    var per = Math.max(1, Number(input.maxPerColumn) || 6)
    var headers = by !== "text" && input.headers !== false
    var origin
    if (section) { var sb = bbox(section); origin = { x: sb.x + PAD, y: sb.y + PAD } } else origin = unionBox(stickies)
    var x = origin.x
    var top = origin.y
    var made = []
    var out = []
    if (headers) await figma.loadFontAsync({ family: "Inter", style: "Bold" })
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g]
      var nodes = grp.ids.map(function (id) { return byId[id] })
      var colW = Math.max.apply(null, nodes.map(function (n) { return n.width }))
      var rowH = Math.max.apply(null, nodes.map(function (n) { return n.height }))
      var y0 = top
      var headerId = null
      if (headers && grp.label) {
        var t = figma.createText()
        t.fontName = { family: "Inter", style: "Bold" }
        t.fontSize = 24
        t.characters = String(grp.label)
        t.fills = [{ type: "SOLID", color: CHARCOAL }]
        insertAfter(nodes[nodes.length - 1], t)
        moveAbs(t, x, top)
        y0 = top + t.height + 16
        headerId = t.id
        made.push(t)
      }
      var cols = by === "text" ? Math.ceil(Math.sqrt(nodes.length)) : Math.ceil(nodes.length / per)
      for (var k = 0; k < nodes.length; k++) {
        var cx = by === "text" ? k % cols : Math.floor(k / per)
        var cy = by === "text" ? Math.floor(k / cols) : k % per
        moveAbs(nodes[k], x + cx * (colW + gap), y0 + cy * (rowH + gap))
      }
      x += cols * (colW + gap) + (by === "text" ? 0 : GAP - gap)
      out.push({ label: grp.label, ids: grp.ids, headerId: headerId })
    }
    if (section) fitSection(section)
    return { groups: out, created: made.map(describe) }
  })

// ------------------------------------------------------------------ tools: batch and run_code

tool("batch",
  "Run several tool calls in order as ONE undo step. Returns each result. Stops at the first error unless stopOnError is false (earlier changes stay; there is no rollback). The batch's expect is checked once before any call (nothing runs on mismatch); each call may carry its own expect/clientId. The batch's expect or confirm covers destructive calls inside it.",
  {
    calls: arr(obj({ name: str(), input: { type: "object" } }), "Tool calls {name, input}."),
    stopOnError: bool("Default true."),
  }, ["calls"],
  async function (input, ctx) {
    var calls = input.calls
    var inner = { actor: ctx && ctx.actor, confirmed: Boolean((ctx && ctx.confirmed) || input.confirm === true || input.expect) }
    if (!Array.isArray(calls) || calls.length === 0) throw new Error("calls must be a non-empty list of {name, input}.")
    if (calls.length > 200) throw new Error("At most 200 calls per batch.")
    var stop = input.stopOnError !== false
    var results = []
    var failed = 0
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i] || {}
      try {
        if (c.name === "batch") throw new Error("batch can't be nested.")
        results.push({ name: c.name, ok: true, result: await runToolCall(c.name, c.input || {}, inner) })
      } catch (error) {
        failed++
        var bad = { name: c.name, ok: false, code: errorCode(error), error: errorText(error) }
        if (error.mismatches) bad.mismatches = error.mismatches
        results.push(bad)
        if (stop) break
      }
    }
    return { results: results, completed: results.length - failed, failed: failed, stopped: stop && failed > 0 && results.length < calls.length }
  })

// Make a run_code result JSON-safe: nodes become summaries, figma.mixed
// becomes "mixed", bytes become their length, cycles and depth are cut.
function jsonSafe(value, depth, seen) {
  if (value === null || value === undefined) return value === null ? null : undefined
  if (typeof value === "symbol") return value === figma.mixed ? "mixed" : String(value)
  if (typeof value === "function") return undefined
  if (typeof value !== "object") return typeof value === "number" && !isFinite(value) ? String(value) : value
  if (value instanceof Uint8Array) return { bytes: value.length }
  if (typeof value.id === "string" && typeof value.type === "string" && "removed" in value) {
    try {
      return value.type === "PAGE" ? { id: value.id, type: "PAGE", name: value.name } : describe(value)
    } catch (error) {
      return { id: value.id, type: value.type }
    }
  }
  if (depth > 8) return "[too deep]"
  if (seen.indexOf(value) >= 0) return "[circular]"
  seen.push(value)
  var out
  if (Array.isArray(value)) {
    out = value.slice(0, 1000).map(function (v) { return jsonSafe(v, depth + 1, seen) })
    if (value.length > 1000) out.push("[+" + (value.length - 1000) + " more]")
  } else {
    out = {}
    var keys = Object.keys(value)
    for (var i = 0; i < keys.length && i < 500; i++) {
      var v = jsonSafe(value[keys[i]], depth + 1, seen)
      if (v !== undefined) out[keys[i]] = v
    }
  }
  seen.pop()
  return out
}

var RUN_PARAMS = ["figma", "tools", "helpers", "console"]

// run_code gets its own copy of the tools, and every call goes through
// runToolCall like any other: expect/confirm checks, page targeting, clientId
// and change attribution under run_code's actor. Passing the raw `tools` map
// would let code skip all of that while looking like it used the guarded tools.
// Each call is checked on its own (run_code's own confirm doesn't carry over),
// and run_code and batch can't be called from inside it.
var NOT_FROM_RUN_CODE = { run_code: true, batch: true }

function guardedTools(ctx) {
  var actor = ctx && ctx.actor
  var out = {}
  Object.keys(tools).forEach(function (name) {
    out[name] = function (input) {
      if (NOT_FROM_RUN_CODE[name]) return Promise.reject(new Error(name + " can't be called from run_code."))
      return runToolCall(name, input || {}, { actor: actor })
    }
  })
  return Object.freeze(out)
}

// Compile `code` as the body of an async function, trying each mechanism the
// sandbox might allow.
function compileAsync(code) {
  var errors = []
  var syntax
  try {
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    return { fn: AsyncFunction.apply(null, RUN_PARAMS.concat([code])), via: "AsyncFunction" }
  } catch (error) {
    if (error && error.name === "SyntaxError") syntax = error
    errors.push("AsyncFunction: " + errorText(error))
  }
  var wrapped = "(async function (" + RUN_PARAMS.join(", ") + ") {\n" + code + "\n})"
  try {
    return { fn: (0, eval)(wrapped), via: "eval" }
  } catch (error) {
    if (error && error.name === "SyntaxError") syntax = error
    errors.push("eval: " + errorText(error))
  }
  try {
    return { fn: new Function("return " + wrapped)(), via: "Function" }
  } catch (error) {
    if (error && error.name === "SyntaxError") syntax = error
    errors.push("Function: " + errorText(error))
  }
  if (syntax) throw new Error("Syntax error in code: " + errorText(syntax))
  throw new Error("This sandbox won't compile code at runtime (" + errors.join("; ") + ").")
}

tool("run_code",
  "Escape hatch: run async Figma Plugin API JavaScript in the plugin sandbox and return its JSON-safe result. The code is a function body: use await and `return`. In scope: figma, tools (call any tool: await tools.get_board({})), helpers (describe, detail, getNode, loadTextFont, solid, hex, palettes), console (log lines are returned). Only works when the user ticked \"Allow run_code\" in the panel.",
  {
    code: str("Function body, e.g. const n = await figma.getNodeByIdAsync(\"1:2\"); return n.name"),
    timeoutMs: int("Default 30000, max 110000."),
  }, ["code"],
  async function (input, ctx) {
    var settings = await loadSettings()
    if (!settings.allowRunCode) throw new Error("run_code is off. The user can turn it on with \"Allow run_code\" in the panel's settings.")
    var compiled = compileAsync(String(input.code || ""))
    var logs = []
    function line(args) {
      var parts = []
      for (var i = 0; i < args.length; i++) {
        var a = args[i]
        parts.push(typeof a === "string" ? a : JSON.stringify(jsonSafe(a, 0, [])))
      }
      if (logs.length < 200) logs.push(parts.join(" ").slice(0, 2000))
    }
    var sandboxConsole = {
      log: function () { line(arguments) },
      info: function () { line(arguments) },
      warn: function () { line(arguments) },
      error: function () { line(arguments) },
    }
    var timeout = Math.min(Math.max(Number(input.timeoutMs) || 30000, 100), 110000)
    var timer
    var result = await Promise.race([
      compiled.fn(figma, guardedTools(ctx), helpers, sandboxConsole),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () { reject(new Error("run_code timed out after " + timeout + " ms (it may still be running).")) }, timeout)
      }),
    ]).then(function (v) { clearTimeout(timer); return v }, function (e) { clearTimeout(timer); throw e })
    var safe = jsonSafe(result, 0, [])
    var text = JSON.stringify(safe === undefined ? null : safe)
    if (text && text.length > 500000) safe = { truncated: true, preview: text.slice(0, 500000) }
    return { result: safe === undefined ? null : safe, logs: logs, via: compiled.via }
  })

var helpers = {
  describe: describe,
  detail: detail,
  getNode: getNode,
  loadTextFont: loadTextFont,
  loadAllFonts: loadAllFonts,
  solid: solid,
  hex: hex,
  bbox: bbox,
  moveAbs: moveAbs,
  palettes: { STICKY: STICKY, SECTION: SECTION, CONNECTOR: CONNECTOR, SHAPE: SHAPE, LABEL: LABEL, TABLE: TABLE },
}

// ------------------------------------------------------------------ revisions, targets, preconditions

function revReplacer(key, value) {
  return typeof value === "symbol" ? "mixed" : value
}

function endpointRev(ep) {
  if (!ep) return null
  if (isFloating(ep)) return ep.position ? [round(ep.position.x), round(ep.position.y)] : null
  return [ep.endpointNodeId, ep.magnet || null]
}

// The node's own editable state (not its children), canonically ordered.
function revState(node) {
  var s = { type: node.type, name: node.name, parent: node.parent ? node.parent.id : null }
  function put(key, read) {
    try {
      var v = read()
      if (v !== undefined) s[key] = v
    } catch (error) {
      // Property not available on this node type.
    }
  }
  put("x", function () { return "x" in node ? round(node.x) : undefined })
  put("y", function () { return "y" in node ? round(node.y) : undefined })
  put("width", function () { return "width" in node ? round(node.width) : undefined })
  put("height", function () { return "height" in node ? round(node.height) : undefined })
  put("rotation", function () { return "rotation" in node ? round(node.rotation) : undefined })
  put("visible", function () { return node.visible })
  put("locked", function () { return node.locked })
  put("opacity", function () { return "opacity" in node ? node.opacity : undefined })
  put("fills", function () { return "fills" in node ? node.fills : undefined })
  put("strokes", function () { return "strokes" in node ? node.strokes : undefined })
  put("strokeWeight", function () { return "strokeWeight" in node ? node.strokeWeight : undefined })
  put("text", function () { return textOf(node) })
  if (node.type === "TABLE") {
    put("cells", function () {
      var rows = []
      for (var r = 0; r < node.numRows; r++) {
        var row = []
        for (var c = 0; c < node.numColumns; c++) row.push(node.cellAt(r, c).text.characters)
        rows.push(row)
      }
      return rows
    })
  }
  if (node.type === "CONNECTOR") put("ends", function () { return [endpointRev(node.connectorStart), endpointRev(node.connectorEnd)] })
  if (node.type === "SECTION") put("contentsHidden", function () { return Boolean(node.sectionContentsHidden) })
  return s
}

// 8-hex revision of a node's own state; pages hash id + name.
function rev(node) {
  if (!node) return null
  if (node.type === "PAGE" || node.type === "DOCUMENT") return fnv1a(node.id + "\u0000" + node.name)
  return fnv1a(JSON.stringify(revState(node), revReplacer))
}

function pageRev(page) {
  return fnv1a(page.children.map(rev).join(","))
}

// Which artifact a call acted on. Every tool result carries it.
function targetInfo(page) {
  page = page || activePage()
  var key
  try {
    key = figma.fileKey
  } catch (error) {
    key = undefined
  }
  return { fileKey: key || null, boardId: boardId(), fileName: figma.root.name, pageId: page.id, pageName: page.name }
}

function toolError(code, message, extra) {
  var error = new Error(message)
  error.code = code
  if (extra) Object.keys(extra).forEach(function (k) { error[k] = extra[k] })
  return error
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

// A node or page by id, or null.
async function lookupAny(id) {
  var pages = figma.root.children
  for (var i = 0; i < pages.length; i++) if (pages[i].id === String(id)) return pages[i]
  var node = await figma.getNodeByIdAsync(String(id))
  return node && !node.removed ? node : null
}

// Check an `expect` block before any change. Throws not_found / precondition_failed.
async function checkExpect(expect) {
  if (expect === undefined || expect === null) return
  if (!isPlainObject(expect)) throw toolError("bad_input", "expect must be an object like {pageId, revs: {id: rev}, names: {id: name}, absent: [ids]}.")
  var t = targetInfo()
  var mismatches = []
  var missing = []
  if (expect.fileKey !== undefined && String(expect.fileKey) !== String(t.fileKey)) mismatches.push({ field: "fileKey", expected: expect.fileKey, actual: t.fileKey })
  if (expect.boardId !== undefined && String(expect.boardId) !== t.boardId) mismatches.push({ field: "boardId", expected: expect.boardId, actual: t.boardId })
  if (expect.pageId !== undefined && String(expect.pageId) !== t.pageId) mismatches.push({ field: "pageId", expected: expect.pageId, actual: t.pageId })
  var fields = [["revs", function (n) { return rev(n) }], ["names", function (n) { return n.name }]]
  for (var f = 0; f < fields.length; f++) {
    var map = expect[fields[f][0]]
    if (map === undefined || map === null) continue
    if (!isPlainObject(map)) throw toolError("bad_input", "expect." + fields[f][0] + " must be an object {nodeId: value}.")
    var ids = Object.keys(map)
    for (var i = 0; i < ids.length; i++) {
      var node = await lookupAny(ids[i])
      if (!node) {
        missing.push({ field: fields[f][0], id: ids[i], expected: map[ids[i]], actual: null })
        continue
      }
      var actual = fields[f][1](node)
      if (String(actual) !== String(map[ids[i]])) mismatches.push({ field: fields[f][0], id: ids[i], expected: map[ids[i]], actual: actual })
    }
  }
  if (expect.absent !== undefined) {
    if (!Array.isArray(expect.absent)) throw toolError("bad_input", "expect.absent must be a list of ids.")
    for (var a = 0; a < expect.absent.length; a++) {
      var there = await lookupAny(expect.absent[a])
      if (there) mismatches.push({ field: "absent", id: String(expect.absent[a]), expected: null, actual: { type: there.type, name: there.name, rev: rev(there) } })
    }
  }
  if (missing.length && !mismatches.length) {
    throw toolError("not_found", "Nothing changed: no node with id " + missing.map(function (m) { return m.id }).join(", ") + " in this file.", { mismatches: missing })
  }
  if (mismatches.length || missing.length) {
    throw toolError("precondition_failed", "Nothing changed: the board isn't in the state you expected. Re-read (get_node / board_tree) and retry with fresh revs.", { mismatches: mismatches.concat(missing) })
  }
}


function isCreateTool(name) {
  return name.indexOf("create_") === 0 || name === "connect" || name === "draw" || name === "stamp" || name === "duplicate"
}

function isDestructive(name, input) {
  if (DESTRUCTIVE[name]) return true
  if (name === "edit_table") return input.removeRow !== undefined || input.removeColumn !== undefined || input.deleteRow !== undefined || input.deleteColumn !== undefined || Boolean(input.clearCell)
  if (name === "move_to") return Boolean(input.pageId || input.pageName)
  return false
}

// Ids a call names in its input.
function inputIds(input) {
  var out = []
  ;["id", "nodeId", "sectionId", "pageId", "parentId"].forEach(function (k) { if (typeof input[k] === "string") out.push(input[k]) })
  if (Array.isArray(input.ids)) input.ids.forEach(function (id) { if (typeof id === "string") out.push(id) })
  return out
}

// Ids a result reports: its own id, ids lists and any list of {id} objects (one level down).
function resultIds(result) {
  var out = []
  function add(v) { if (typeof v === "string" && out.indexOf(v) < 0) out.push(v) }
  if (!isPlainObject(result)) {
    if (Array.isArray(result)) result.forEach(function (r) { if (r && typeof r.id === "string") add(r.id) })
    return out
  }
  add(result.id)
  Object.keys(result).forEach(function (k) {
    var v = result[k]
    if (!Array.isArray(v)) return
    v.forEach(function (item) {
      if (typeof item === "string" && k === "ids") add(item)
      else if (item && typeof item.id === "string") add(item.id)
    })
  })
  return out
}

var sessionCreated = {} // actor → { nodeId: true }, for the implicit-confirm rule
var recentWrites = {} // nodeId → { actor, until }, to attribute late nodechange events

function guardDestructive(name, input, actor) {
  if (!actor || !isDestructive(name, input)) return
  if (input.confirm === true || input.expect) return
  if (actor.indexOf("panel:") === 0) {
    // The panel only offers run_code when the user turned on "Allow run_code";
    // that setting is the user's consent, so the panel's own agent needs no
    // per-call confirm. Remote agents still do.
    if (name === "run_code") return
    var ids = inputIds(input)
    var mine = sessionCreated[actor]
    if (ids.length && mine && ids.every(function (id) { return mine[id] })) return
  }
  throw toolError("confirm_required", name + " changes or removes existing content: pass expect (e.g. {revs: {id: rev}} or {pageId} from your last read) so it only acts on what you saw, or confirm: true when the user explicitly asked for it. Nothing changed.")
}

function nodeOut(node) {
  if (node.type === "PAGE") return { id: node.id, type: "PAGE", name: node.name, rev: rev(node) }
  return describe(node)
}

async function findByClientId(name, clientId) {
  if (name === "create_page") return figma.root.children.filter(function (p) { return p.getPluginData(CLIENT_ID_KEY) === clientId })
  var matches = function (n) {
    return typeof n.getPluginData === "function" && n.getPluginData(CLIENT_ID_KEY) === clientId
  }
  // Indexed lookup by plugin-data key; some node types (e.g. table cells) have
  // no getPluginData, so the fallback scan guards for it.
  try {
    return activePage().findAllWithCriteria({ pluginData: { keys: [CLIENT_ID_KEY] } }).filter(matches)
  } catch (error) {
    return activePage().findAll(matches)
  }
}

// One tool call with the shared guards: expect, confirm, clientId, revs.
async function runToolCall(name, input, ctx) {
  var fn = tools[name]
  if (!fn) throw toolError("unknown_tool", "Unknown tool " + name)
  input = isPlainObject(input) ? input : {}
  ctx = ctx || {}
  if (!toolMeta[name].ownsPage && (input.pageId || input.pageName)) {
    var page = await resolveTargetPage(input)
    if (page !== activePage()) {
      var prev = TARGET_PAGE
      var host = figma.currentPage
      var before = {}
      host.children.forEach(function (n) { before[n.id] = true })
      TARGET_PAGE = page === figma.currentPage ? null : page
      try {
        return await runOnPage(name, input, ctx, function () { if (TARGET_PAGE) adoptStrays(host, before, TARGET_PAGE) })
      } finally {
        TARGET_PAGE = prev
      }
    }
  }
  return await runOnPage(name, input, ctx)
}

async function runOnPage(name, input, ctx, settle) {
  var fn = tools[name]
  ctx.page = activePage()
  var readOnly = Boolean(toolMeta[name].readOnly)
  if (!readOnly) {
    await checkExpect(input.expect)
    if (!ctx.confirmed) guardDestructive(name, input, ctx.actor)
    if (typeof input.clientId === "string" && input.clientId && isCreateTool(name)) {
      var existing = await findByClientId(name, input.clientId)
      if (existing.length) {
        return { changed: false, clientId: input.clientId, id: existing[0].id, created: existing.map(nodeOut), note: "Already created by an earlier call with this clientId; nothing new was made." }
      }
    }
  }
  var result
  try {
    result = await fn(input, ctx)
  } finally {
    if (settle) settle()
  }
  if (!readOnly) {
    var ids = resultIds(result)
    if (isCreateTool(name) && ids.length) {
      var mine = ctx.actor ? (sessionCreated[ctx.actor] = sessionCreated[ctx.actor] || {}) : null
      for (var i = 0; i < ids.length; i++) {
        if (mine) mine[ids[i]] = true
        if (typeof input.clientId === "string" && input.clientId) {
          var made = await lookupAny(ids[i])
          if (made) made.setPluginData(CLIENT_ID_KEY, input.clientId)
        }
      }
    }
    var touched = ids.concat(inputIds(input).filter(function (id) { return ids.indexOf(id) < 0 }))
    var until = Date.now() + 3000
    touched.forEach(function (id) { recentWrites[id] = { actor: ctx.actor, until: until } })
    if (isPlainObject(result) && touched.length && touched.length <= 400) {
      var revs = {}
      for (var r = 0; r < touched.length; r++) {
        var n = await lookupAny(touched[r])
        if (n) revs[n.id] = rev(n)
      }
      result.revs = revs
    }
  }
  return result
}

function errorCode(error) {
  if (error && error.code) return error.code
  var text = errorText(error)
  if (/^No (node with id|page) /.test(text)) return "not_found"
  return "error"
}

// ------------------------------------------------------------------ markup (pen, highlighter, stamps, tape)

var MARKUP_TYPES = { HIGHLIGHT: true, VECTOR: true, STAMP: true, WASHI_TAPE: true }
var TEXT_TYPES = { TEXT: true, STICKY: true, SHAPE_WITH_TEXT: true, CODE_BLOCK: true }
var CONTAINER_TYPES = { SECTION: true, TABLE: true }

function box(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
}

// Absolute points of a vector-like node, in drawing order.
function strokePoints(node) {
  var pts = []
  try {
    var t = node.absoluteTransform
    var verts = node.vectorNetwork.vertices
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i]
      pts.push({ x: t[0][0] * v.x + t[0][1] * v.y + t[0][2], y: t[1][0] * v.x + t[1][1] * v.y + t[1][2] })
    }
  } catch (error) {
    // No vector network (stamp, tape): fall back to the box diagonal.
  }
  return pts
}

function subpathCount(node) {
  try {
    var n = 0
    node.vectorPaths.forEach(function (p) { n += (String(p.data).match(/M/g) || []).length })
    return n
  } catch (error) {
    return 1
  }
}

function turnAngle(a, b, c) {
  var v1x = b.x - a.x
  var v1y = b.y - a.y
  var v2x = c.x - b.x
  var v2y = c.y - b.y
  var l1 = Math.sqrt(v1x * v1x + v1y * v1y)
  var l2 = Math.sqrt(v2x * v2x + v2y * v2y)
  if (!l1 || !l2) return 0
  var cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)))
  return Math.acos(cos) * 180 / Math.PI
}

// Shape features of one stroke. pts: absolute points; b: {x, y, width, height}.
function strokeFeatures(pts, b) {
  var len = 0
  for (var i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
  var diag = Math.sqrt(b.width * b.width + b.height * b.height) || 1
  var first = pts[0] || { x: b.x, y: b.y }
  var last = pts[pts.length - 1] || { x: b.x + b.width, y: b.y + b.height }
  var chord = dist(first, last)
  // Sharp turns on a resampled path (ignores jitter between close points).
  var sample = [first]
  var step = Math.max(len / 24, 1)
  var acc = 0
  for (var k = 1; k < pts.length; k++) {
    acc += dist(pts[k - 1], pts[k])
    if (acc >= step) {
      sample.push(pts[k])
      acc = 0
    }
  }
  if (sample[sample.length - 1] !== last) sample.push(last)
  var turns = []
  var walked = 0
  for (var s = 1; s < sample.length - 1; s++) {
    walked += dist(sample[s - 1], sample[s])
    var angle = turnAngle(sample[s - 1], sample[s], sample[s + 1])
    if (angle > 60) turns.push({ at: len ? walked / len : 0, angle: angle, index: s, point: sample[s] })
  }
  return { len: len, diag: diag, chord: chord, straight: len ? chord / len : 1, first: first, last: last, turns: turns, width: b.width, height: b.height }
}

// Gesture of a single stroke from its geometry (two-stroke crosses are paired separately).
function classifyStroke(pts, b, subpaths) {
  if (pts.length < 2) return "mark"
  var f = strokeFeatures(pts, b)
  if (f.chord <= 0.3 * f.diag && f.len >= 1.8 * f.diag) return "circle"
  var sharp = f.turns.filter(function (t) { return t.angle > 110 })
  if ((subpaths >= 2 || sharp.length >= 1) && sharp.length <= 2) {
    var head = sharp.length ? sharp[0].at : 1
    if (subpaths >= 2 || head >= 0.6) {
      var shaftEnd = sharp.length ? sharp[0].point : f.last
      if (dist(f.first, shaftEnd) >= 0.6 * f.diag) return "arrow"
    }
  }
  if (f.turns.length >= 4 || (f.len > 4 * f.diag && f.straight < 0.3)) return "scribble"
  if (f.turns.length >= 1 && f.turns.length <= 2 && f.straight > 0.5) {
    var corner = f.turns[0].point
    var down = dist(f.first, corner)
    var up = dist(corner, f.last)
    if (corner.y > f.first.y && corner.y > f.last.y && f.last.y < f.first.y && up > 1.3 * down) return "check"
  }
  if (f.straight > 0.85) {
    if (f.height <= Math.max(0.3 * f.width, 24)) return "line"
    return "strike"
  }
  return "mark"
}

// Two long, straight-ish strokes whose chords cross at an angle, with overlapping boxes → an X.
function isCrossPair(a, b) {
  var fa = strokeFeatures(a.pts, a.bounds)
  var fb = strokeFeatures(b.pts, b.bounds)
  if (fa.straight < 0.75 || fb.straight < 0.75) return false
  if (!segsCross(fa.first, fa.last, fb.first, fb.last)) return false
  var angle = turnAngle({ x: 0, y: 0 }, { x: fa.last.x - fa.first.x, y: fa.last.y - fa.first.y }, { x: fa.last.x - fa.first.x + fb.last.x - fb.first.x, y: fa.last.y - fa.first.y + fb.last.y - fb.first.y })
  if (angle < 30 || angle > 150) return false
  var inter = overlapArea(a.bounds, b.bounds)
  var smaller = Math.min(a.bounds.width * a.bounds.height, b.bounds.width * b.bounds.height) || 1
  var lenRatio = Math.min(fa.len, fb.len) / Math.max(fa.len, fb.len)
  return inter / smaller >= 0.4 && lenRatio >= 0.4
}

// Approximate substring of `text` under markup box m, for a node box n (by line, then by width).
function coveredText(text, n, m) {
  if (typeof text !== "string" || !text) return undefined
  var lines = text.split("\n")
  var count = lines.length
  var top = Math.max(0, (Math.max(m.y, n.y) - n.y) / n.height)
  var bottom = Math.min(1, (Math.min(m.y + m.height, n.y + n.height) - n.y) / n.height)
  var left = Math.max(0, (Math.max(m.x, n.x) - n.x) / n.width)
  var right = Math.min(1, (Math.min(m.x + m.width, n.x + n.width) - n.x) / n.width)
  if (bottom <= top || right <= left) return undefined
  var i0 = Math.min(count - 1, Math.floor(top * count))
  var i1 = Math.max(i0, Math.min(count - 1, Math.ceil(bottom * count) - 1))
  var out = []
  for (var i = i0; i <= i1; i++) {
    var line = lines[i]
    var s = left > 0.05 ? Math.floor(left * line.length) : 0
    var e = right < 0.95 ? Math.ceil(right * line.length) : line.length
    out.push(line.slice(s, e))
  }
  return out.join("\n").trim() || undefined
}

// Things markup can cover: text-bearing nodes, table cells, sections and tables.
function coverTargets(page) {
  var out = []
  var nodes = page.findAll(function (n) { return TEXT_TYPES[n.type] || CONTAINER_TYPES[n.type] })
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    var b = n.absoluteBoundingBox
    if (!b) continue
    out.push({ id: n.id, type: n.type, name: n.name, bounds: b, text: textOf(n), container: Boolean(CONTAINER_TYPES[n.type]) })
    if (n.type === "TABLE") out = out.concat(tableCellTargets(n, b))
  }
  return out
}

function tableCellTargets(table, b) {
  var out = []
  try {
    var widths = []
    var heights = []
    for (var c = 0; c < table.numColumns; c++) widths.push(table.cellAt(0, c).width)
    for (var r = 0; r < table.numRows; r++) heights.push(table.cellAt(r, 0).height)
    var y = b.y
    for (var row = 0; row < table.numRows; row++) {
      var x = b.x
      for (var col = 0; col < table.numColumns; col++) {
        var cell = table.cellAt(row, col)
        var o = { id: table.id, type: "TABLE_CELL", bounds: { x: x, y: y, width: widths[col], height: heights[row] }, text: cell.text.characters, cell: { row: row, col: col } }
        if (row > 0) o.cell.colHeader = clipText(table.cellAt(0, col).text.characters)
        if (col > 0) o.cell.rowHeader = clipText(table.cellAt(row, 0).text.characters)
        out.push(o)
        x += widths[col]
      }
      y += heights[row]
    }
  } catch (error) {
    // Table geometry unavailable; the table itself still counts.
  }
  return out
}

// What a markup box covers, best first.
function coversFor(m, targets, inflate) {
  var probe = { x: m.x - inflate, y: m.y - inflate, width: m.width + 2 * inflate, height: m.height + 2 * inflate }
  var probeArea = probe.width * probe.height || 1
  var out = []
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i]
    var area = t.bounds.width * t.bounds.height || 1
    var inter = overlapArea(probe, t.bounds)
    if (!inter) continue
    var coverage = inter / area
    var keep = t.container ? coverage >= 0.3 : coverage >= 0.15 || inter / probeArea >= 0.3
    if (!keep) continue
    var o = { id: t.id, type: t.type, coverage: Math.round(Math.min(1, coverage) * 100) / 100 }
    if (t.name && t.container) o.name = t.name
    if (t.cell) {
      o.cell = t.cell
      if (t.text) o.text = clipText(t.text)
    } else if (!t.container && t.text) o.text = clipText(coveredText(t.text, t.bounds, probe) || "")
    out.push(o)
  }
  out.sort(function (a, b) { return b.coverage - a.coverage })
  return out.slice(0, 20)
}

function markupColor(node) {
  var c = solidColor(node.strokes) || solidColor(node.fills)
  return c ? hex(c) : undefined
}

function markupKind(node) {
  if (node.type === "HIGHLIGHT") return "highlight"
  if (node.type === "STAMP") return "stamp"
  if (node.type === "WASHI_TAPE") return "tape"
  var weight = typeof node.strokeWeight === "number" ? node.strokeWeight : 0
  if (node.name === "Highlighter" || (weight >= 12 && node.opacity < 0.7)) return "highlight"
  return "pen"
}

// Build markup items from raw strokes [{id, kind, color, rev, bounds, pts, subpaths}] and cover targets.
function markupItems(raw, targets) {
  var used = {}
  var items = []
  for (var i = 0; i < raw.length; i++) {
    if (used[raw[i].id]) continue
    var a = raw[i]
    if (a.kind === "pen") {
      for (var j = i + 1; j < raw.length; j++) {
        var b = raw[j]
        if (used[b.id] || b.kind !== "pen" || !isCrossPair(a, b)) continue
        used[a.id] = used[b.id] = true
        var u = { x: Math.min(a.bounds.x, b.bounds.x), y: Math.min(a.bounds.y, b.bounds.y) }
        u.width = Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - u.x
        u.height = Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - u.y
        items.push({ id: a.id, ids: [a.id, b.id], kind: "pen", gesture: "cross", color: a.color, rev: fnv1a(a.rev + b.rev), revs: pairRevs(a, b), box: u })
        break
      }
      if (used[a.id]) continue
    }
    var gesture = a.kind === "stamp" || a.kind === "tape" ? "mark" : classifyStroke(a.pts, a.bounds, a.subpaths)
    items.push({ id: a.id, kind: a.kind, gesture: gesture, color: a.color, rev: a.rev, box: a.bounds, stamp: a.stamp })
  }
  return items.map(function (it) {
    var thin = it.gesture === "line" || it.gesture === "mark"
    var covers = coversFor(it.box, targets, thin && it.kind === "pen" ? 12 : 0)
    if (it.gesture === "line" || (it.kind === "highlight" && it.gesture !== "circle" && it.gesture !== "cross")) {
      it.gesture = it.kind === "highlight" ? "mark" : underlineOrStrike(it.box, covers, targets)
    }
    var o = { id: it.id, kind: it.kind, gesture: it.gesture, color: it.color, rev: it.rev, bounds: box(it.box), covers: covers }
    if (it.ids) {
      o.ids = it.ids
      o.revs = it.revs
    }
    if (it.stamp) o.stamp = it.stamp
    var texts = covers.filter(function (c) { return c.text }).map(function (c) { return c.text })
    if (texts.length) o.textCovered = texts.join(" | ")
    return o
  })
}

function pairRevs(a, b) {
  var o = {}
  o[a.id] = a.rev
  o[b.id] = b.rev
  return o
}

// A flat line under text is an underline; through its middle, a strike.
function underlineOrStrike(m, covers, targets) {
  var cy = m.y + m.height / 2
  for (var i = 0; i < covers.length; i++) {
    if (covers[i].type === "SECTION" || covers[i].type === "TABLE") continue
    for (var k = 0; k < targets.length; k++) {
      var t = targets[k]
      if (t.id !== covers[i].id || (covers[i].cell && (!t.cell || t.cell.row !== covers[i].cell.row || t.cell.col !== covers[i].cell.col))) continue
      var rel = (cy - t.bounds.y) / (t.bounds.height || 1)
      return rel >= 0.7 ? "underline" : "strike"
    }
  }
  return "underline"
}

function rawMarkup(node) {
  var b = node.absoluteBoundingBox || bbox(node)
  var o = { id: node.id, kind: markupKind(node), color: markupColor(node), rev: rev(node), bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, pts: strokePoints(node), subpaths: subpathCount(node) }
  if (node.type === "STAMP") o.stamp = node.name
  return o
}

async function markupScope(input) {
  var page = activePage()
  if (input.pageId) {
    page = await getPage({ id: input.pageId })
    await page.loadAsync()
  }
  return page
}

async function collectMarkup(page, input) {
  var nodes
  if (Array.isArray(input.ids) && input.ids.length) {
    nodes = (await getNodes(input.ids, 200)).filter(function (n) { return MARKUP_TYPES[n.type] })
  } else {
    nodes = page.findAll(function (n) { return MARKUP_TYPES[n.type] })
  }
  if (input.sectionId) {
    var section = await getSection(input.sectionId)
    var sb = section.absoluteBoundingBox
    nodes = nodes.filter(function (n) {
      var b = n.absoluteBoundingBox
      return b && overlapArea(sb, b) > 0
    })
  }
  return markupItems(nodes.slice(0, 300).map(rawMarkup), coverTargets(page))
}

tool("read_markup",
  "What people drew on the board: pen strokes, highlighter, stamps and washi tape, interpreted. Each item: kind (highlight|pen|stamp|tape), gesture (underline|strike|circle|cross|arrow|check|scribble|mark — two pen strokes forming an X come back as ONE cross item with both ids), color, rev, bounds, and covers: the text nodes, table cells (row/col + row/column header text), stickies, shapes and sections it lies over, with coverage 0–1 (share of that target covered) and textCovered (approximate: estimated by line and width from bounding boxes). Use this to understand user annotations (\"the highlighted cells\", \"the crossed-out section\") before acting on them.",
  {
    pageId: str("Page to read (default current)."),
    sectionId: str("Only markup over this section."),
    ids: arr(str(), "Only these markup nodes."),
  }, [],
  async function (input) {
    var page = await markupScope(input)
    var items = await collectMarkup(page, input)
    return { pageId: page.id, items: items, count: items.length }
  }, { readOnly: true })

// ------------------------------------------------------------------ board tree

function roleOf(node) {
  switch (node.type) {
    case "TEXT": {
      var size = fontSizeOf(node)
      if (size >= 24) return "heading"
      if (size && size <= 12) return "label"
      return "body"
    }
    case "STICKY": return "sticky"
    case "SHAPE_WITH_TEXT": return "card"
    case "SECTION":
    case "GROUP": return "container"
    case "TABLE": return "table"
    case "CODE_BLOCK": return "code"
    case "CONNECTOR": return "connector"
    case "MEDIA":
    case "LINK_UNFURL":
    case "EMBED": return "media"
    default:
      if (MARKUP_TYPES[node.type]) return "markup"
      if ("fills" in node && Array.isArray(node.fills) && node.fills.some(function (p) { return p.type === "IMAGE" })) return "media"
      return textOf(node) ? "label" : "shape"
  }
}

// Rows top→bottom (a tolerance band per row), then left→right.
function readingOrder(items) {
  var sorted = items.slice().sort(function (a, b) { return a.b.y - b.b.y })
  var rows = []
  var cur = null
  for (var i = 0; i < sorted.length; i++) {
    var it = sorted[i]
    var tol = Math.max(16, Math.min(it.b.height, cur ? cur.h : it.b.height) * 0.5)
    if (cur && it.b.y - cur.y0 <= tol) {
      cur.items.push(it)
      cur.h = Math.max(cur.h, it.b.height)
    } else {
      cur = { y0: it.b.y, h: it.b.height, items: [it] }
      rows.push(cur)
    }
  }
  var out = []
  rows.forEach(function (r) {
    r.items.sort(function (a, b) { return a.b.x - b.b.x })
    out = out.concat(r.items)
  })
  return out
}

function treeNode(node, depth, opts, ctx) {
  ctx.count++
  ctx.counts[node.type] = (ctx.counts[node.type] || 0) + 1
  var o = { id: node.id, type: node.type, name: node.name, rev: rev(node), role: roleOf(node) }
  var b = node.absoluteBoundingBox || bbox(node)
  if (opts.geometry && b) o.bounds = box(b)
  if (opts.text) {
    var text = textOf(node)
    if (typeof text === "string" && text) o.text = text.length > 2000 ? text.slice(0, 2000) + "…" : text
  }
  if (opts.style) {
    var style = {}
    if (node.type === "STICKY") style.color = colorName(STICKY, node.fills)
    if (node.type === "SECTION") style.color = colorName(SECTION, node.fills)
    if (node.type === "SHAPE_WITH_TEXT") {
      style.shape = node.shapeType
      style.color = colorName(SHAPE, node.fills)
    }
    var c = "fills" in node ? solidColor(node.fills) : undefined
    if (c) style.fill = hex(c)
    var size = fontSizeOf(textTarget(node) || node)
    if (size) style.fontSize = size
    o.style = style
  }
  if (node.type === "TABLE") {
    var cells = tableCells(node, 400)
    o.table = { rows: cells.rows.map(function (r) { return r.map(function (c) { return c.text }) }), cols: node.numColumns, truncated: cells.truncated || undefined }
  }
  if (node.type === "SECTION") o.contentsHidden = Boolean(node.sectionContentsHidden) || undefined
  if ("children" in node && node.type !== "TABLE") {
    var kids = node.children.filter(function (c) {
      if (c.type === "CONNECTOR" || MARKUP_TYPES[c.type]) {
        ctx.counts[c.type] = (ctx.counts[c.type] || 0) + 1
        return false
      }
      return true
    })
    if (depth <= 0) {
      if (kids.length) o.childCount = kids.length
    } else {
      var ordered = readingOrder(kids.map(function (c) { return { node: c, b: c.absoluteBoundingBox || bbox(c) } }))
      o.children = []
      for (var i = 0; i < ordered.length; i++) {
        if (ctx.count >= ctx.limit) {
          ctx.truncated = true
          o.more = ordered.length - i
          break
        }
        o.children.push(treeNode(ordered[i].node, depth - 1, opts, ctx))
      }
    }
  }
  return o
}

function edgeOut(c) {
  var e = { id: c.id, rev: rev(c) }
  var s = c.connectorStart
  var t = c.connectorEnd
  if (!isFloating(s)) {
    e.from = s.endpointNodeId
    e.fromMagnet = s.magnet
  } else if (s && s.position) e.fromPoint = { x: Math.round(s.position.x), y: Math.round(s.position.y) }
  if (!isFloating(t)) {
    e.to = t.endpointNodeId
    e.toMagnet = t.magnet
  } else if (t && t.position) e.toPoint = { x: Math.round(t.position.x), y: Math.round(t.position.y) }
  var label = c.text && c.text.characters
  if (label) e.label = clipText(label)
  return e
}

tool("board_tree",
  "The best way to understand a board: a semantic tree of the page (or one section/group) in reading order (rows top→bottom, then left→right). Each node has id, type, name, rev, role (heading, body, label, sticky, card, container, table, code, media, shape), bounds, text; tables include a rows×cols matrix of cell text. Connectors come back as graph edges {from, to, magnets, label}; pen/highlighter/stamps as interpreted markup (same as read_markup). Also a summary (counts by type, sections). Pass the revs you read here in expect.revs when you change those nodes.",
  {
    pageId: str("Page (default current)."),
    rootId: str("Only this section/group subtree."),
    depth: int("Levels below the root (default 6, max 12)."),
    include: arr(str(), "Any of text, geometry, style (default text + geometry)."),
    limit: int("Max nodes (default 500, max 2000)."),
  }, [],
  async function (input) {
    var page = await markupScope(input)
    var include = Array.isArray(input.include) && input.include.length ? input.include.map(function (s) { return String(s).toLowerCase() }) : ["text", "geometry"]
    var opts = { text: include.indexOf("text") >= 0, geometry: include.indexOf("geometry") >= 0, style: include.indexOf("style") >= 0 }
    var depth = Math.min(Math.max(typeof input.depth === "number" ? input.depth : 6, 0), 12)
    var ctx = { count: 0, limit: Math.min(Math.max(Number(input.limit) || 500, 1), 2000), counts: {}, truncated: false }
    var rootNode = input.rootId ? await getNode(input.rootId) : page
    var root
    if (rootNode.type === "PAGE") {
      root = { id: page.id, type: "PAGE", name: page.name, rev: pageRev(page), role: "page", children: [] }
      var kids = page.children.filter(function (c) {
        if (c.type === "CONNECTOR" || MARKUP_TYPES[c.type]) {
          ctx.counts[c.type] = (ctx.counts[c.type] || 0) + 1
          return false
        }
        return true
      })
      var ordered = readingOrder(kids.map(function (c) { return { node: c, b: c.absoluteBoundingBox || bbox(c) } }))
      for (var i = 0; i < ordered.length; i++) {
        if (ctx.count >= ctx.limit) {
          ctx.truncated = true
          root.more = ordered.length - i
          break
        }
        root.children.push(treeNode(ordered[i].node, depth - 1, opts, ctx))
      }
    } else root = treeNode(rootNode, depth, opts, ctx)
    var scope = rootNode.type === "PAGE" ? page : rootNode
    var connectors = "findAll" in scope ? scope.findAll(function (n) { return n.type === "CONNECTOR" }) : []
    var markup = []
    try {
      markup = await collectMarkup(page, {})
      if (rootNode.type !== "PAGE") {
        var rb = rootNode.absoluteBoundingBox
        markup = markup.filter(function (m) { return overlapArea(rb, { x: m.bounds.x, y: m.bounds.y, width: m.bounds.w, height: m.bounds.h }) > 0 })
      }
    } catch (error) {
      markup = [{ error: errorText(error) }]
    }
    var sections = ("findAll" in scope ? scope.findAll(function (n) { return n.type === "SECTION" }) : []).map(function (s) {
      return { id: s.id, name: s.name, childCount: s.children.length }
    })
    return {
      rev: pageRev(page),
      root: root,
      edges: connectors.slice(0, 1000).map(edgeOut),
      markup: markup,
      summary: { counts: ctx.counts, sections: sections, nodes: ctx.count, truncated: ctx.truncated || undefined },
    }
  }, { readOnly: true })

// ------------------------------------------------------------------ change feed

var changeQueue = []
var changeIndex = {}
var changeTimer = null
var changeSelection = null
var currentCall = null // the write call executing now: { actor }
var lastCall = null // { actor, endedAt }
var watchedPage = null

function changeActor(change) {
  if (change.origin === "REMOTE") return "remote"
  var recent = recentWrites[change.id]
  if (recent && recent.until > Date.now() && recent.actor) return recent.actor
  if (currentCall) return currentCall.actor || "plugin"
  if (lastCall && Date.now() - lastCall.endedAt < 500 && lastCall.actor) return lastCall.actor
  return "user"
}

function scheduleChanges() {
  if (!changeTimer) changeTimer = setTimeout(flushChanges, 250)
}

function onNodeChange(event) {
  var list = (event && event.nodeChanges) || []
  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    var actor = changeActor(c)
    var key = c.id + "|" + actor
    var prev = changeIndex[key]
    if (prev) {
      if (c.type === "DELETE") prev.kind = "DELETE"
      else if (c.type === "PROPERTY_CHANGE" && prev.kind === "PROPERTY_CHANGE" && c.properties) {
        c.properties.forEach(function (p) { if (prev.properties.indexOf(p) < 0) prev.properties.push(p) })
      }
      prev.node = c.node
      continue
    }
    var o = { id: c.id, kind: c.type, nodeType: c.node && c.node.type, actor: actor, node: c.node, properties: c.type === "PROPERTY_CHANGE" && c.properties ? c.properties.slice() : undefined }
    changeIndex[key] = o
    changeQueue.push(o)
  }
  scheduleChanges()
}

function flushChanges() {
  changeTimer = null
  var batch = changeQueue
  changeQueue = []
  changeIndex = {}
  var cheap = batch.length <= 200
  var changes = batch.map(function (c) {
    var o = { id: c.id, kind: c.kind, actor: c.actor }
    if (c.nodeType) o.nodeType = c.nodeType
    if (c.properties) o.properties = c.properties
    if (cheap && c.kind !== "DELETE" && c.node && !c.node.removed) {
      try {
        o.rev = rev(c.node)
      } catch (error) {
        // Node went away between the event and the flush.
      }
    }
    return o
  })
  var msg = { type: "changes", target: targetInfo(figma.currentPage), changes: changes }
  if (changeSelection) {
    msg.selection = changeSelection
    changeSelection = null
  }
  if (changes.length || msg.selection) figma.ui.postMessage(msg)
  var now = Date.now()
  Object.keys(recentWrites).forEach(function (id) { if (recentWrites[id].until < now) delete recentWrites[id] })
}

function noteSelection() {
  changeSelection = { ids: figma.currentPage.selection.map(function (n) { return n.id }), actor: "user" }
  scheduleChanges()
}

// nodechange on the current page only (no loadAllPagesAsync); re-subscribed on page switches.
function watchPage() {
  if (watchedPage) {
    try {
      watchedPage.off("nodechange", onNodeChange)
    } catch (error) {
      // Page gone.
    }
  }
  watchedPage = figma.currentPage
  try {
    watchedPage.on("nodechange", onNodeChange)
  } catch (error) {
    watchedPage = null
  }
}

// ------------------------------------------------------------------ version

function fnv1a(s) {
  var hash = 0x811c9dc5
  for (var i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return ("0000000" + hash.toString(16)).slice(-8)
}

// A short build id that changes whenever ui.html, a tool schema or a tool's
// code changes, even if PLUGIN_VERSION wasn't bumped.
var BUILD = (function () {
  var sources = ""
  Object.keys(tools).forEach(function (k) {
    try {
      sources += String(tools[k])
    } catch (error) {
      // Function source unavailable in this sandbox; the schemas still count.
    }
  })
  return fnv1a(String(__html__)).slice(0, 4) + fnv1a(JSON.stringify(toolSpecs) + sources).slice(0, 4)
})()

function versionInfo() {
  return { version: PLUGIN_VERSION, build: BUILD, loadedAt: LOADED_AT }
}

// ------------------------------------------------------------------ chats

var BOARD_ID_KEY = "maximal.boardId"
var CHAT_INDEX_PREFIX = "maximal.chats."
var CHAT_PREFIX = "maximal.chat."
var CHAT_SIZE_LIMIT = 800000
var CHAT_LIMIT = 40

function boardId() {
  var id = figma.root.getPluginData(BOARD_ID_KEY)
  if (id) return id
  var alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  id = ""
  for (var i = 0; i < 10; i++) id += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  figma.root.setPluginData(BOARD_ID_KEY, id)
  return id
}

function chatIndexKey(id) {
  return CHAT_INDEX_PREFIX + id
}

function chatKey(id, chatId) {
  return CHAT_PREFIX + id + "." + chatId
}

function sortChats(chats) {
  return chats.sort(function (a, b) {
    var aTime = Date.parse(a.updatedAt || "") || 0
    var bTime = Date.parse(b.updatedAt || "") || 0
    return bTime - aTime
  })
}

async function loadChatIndex(id) {
  var chats = await figma.clientStorage.getAsync(chatIndexKey(id))
  if (!Array.isArray(chats)) return []
  return sortChats(chats.filter(function (chat) {
    return chat && typeof chat === "object" && typeof chat.id === "string"
  }))
}

function stripChatImages(value) {
  if (Array.isArray(value)) {
    return value.map(function (item) { return stripChatImages(item) })
  }
  if (!value || typeof value !== "object") return value
  if (value.type === "image") return { type: "text", text: "[image not saved]" }
  var copy = {}
  Object.keys(value).forEach(function (key) {
    copy[key] = stripChatImages(value[key])
  })
  return copy
}

function collectToolResultText(value, insideToolResult, refs) {
  if (Array.isArray(value)) {
    value.forEach(function (item) { collectToolResultText(item, insideToolResult, refs) })
    return
  }
  if (!value || typeof value !== "object") return
  var inside = insideToolResult || value.type === "tool_result"
  Object.keys(value).forEach(function (key) {
    var child = value[key]
    if (inside && (key === "content" || key === "text") && typeof child === "string" && child.length > 2000) {
      refs.push({ holder: value, key: key })
    } else if (child && typeof child === "object") {
      collectToolResultText(child, inside, refs)
    }
  })
}

function prepareChat(chat) {
  var prepared = stripChatImages(chat)
  var json = JSON.stringify(prepared)
  if (json.length <= CHAT_SIZE_LIMIT) return prepared
  var refs = []
  collectToolResultText(prepared.messages, false, refs)
  for (var i = 0; i < refs.length && json.length > CHAT_SIZE_LIMIT; i++) {
    var ref = refs[i]
    ref.holder[ref.key] = ref.holder[ref.key].slice(0, 2000) + "…[truncated]"
    json = JSON.stringify(prepared)
  }
  if (json.length > CHAT_SIZE_LIMIT) throw new Error("Chat is too large to save after truncating tool results.")
  return prepared
}

function countTurns(messages) {
  if (!Array.isArray(messages)) return 0
  var turns = 0
  messages.forEach(function (message) {
    if (!message || message.role !== "user") return
    if (typeof message.content === "string") {
      turns++
      return
    }
    if (Array.isArray(message.content) && message.content.some(function (block) {
      return block && block.type === "text"
    })) turns++
  })
  return turns
}

function chatIndexEntry(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    model: chat.model,
    effort: chat.effort,
    turns: countTurns(chat.messages),
  }
}

async function saveChat(id, input) {
  if (!input || typeof input !== "object" || !input.id) throw new Error("Chat id is required.")
  var now = new Date().toISOString()
  var record = prepareChat({
    id: String(input.id),
    title: String(input.title || "Untitled chat"),
    createdAt: input.createdAt || now,
    updatedAt: now,
    model: input.model || "",
    effort: input.effort || "",
    messages: Array.isArray(input.messages) ? input.messages : [],
  })
  await figma.clientStorage.setAsync(chatKey(id, record.id), record)
  var chats = await loadChatIndex(id)
  chats = chats.filter(function (chat) { return chat.id !== record.id })
  chats.unshift(chatIndexEntry(record))
  sortChats(chats)
  var removed = chats.slice(CHAT_LIMIT)
  chats = chats.slice(0, CHAT_LIMIT)
  await figma.clientStorage.setAsync(chatIndexKey(id), chats)
  for (var i = 0; i < removed.length; i++) {
    await figma.clientStorage.deleteAsync(chatKey(id, removed[i].id))
  }
  return chats
}

async function renameChat(id, chatId, title) {
  var key = chatKey(id, chatId)
  var record = await figma.clientStorage.getAsync(key)
  if (!record) throw new Error("Chat not found: " + chatId)
  record.title = String(title || "Untitled chat")
  record.updatedAt = new Date().toISOString()
  await figma.clientStorage.setAsync(key, record)
  var chats = await loadChatIndex(id)
  chats = chats.filter(function (chat) { return chat.id !== chatId })
  chats.unshift(chatIndexEntry(record))
  sortChats(chats)
  await figma.clientStorage.setAsync(chatIndexKey(id), chats)
  return chats
}

async function deleteChat(id, chatId) {
  await figma.clientStorage.deleteAsync(chatKey(id, chatId))
  var chats = await loadChatIndex(id)
  chats = chats.filter(function (chat) { return chat.id !== chatId })
  await figma.clientStorage.setAsync(chatIndexKey(id), chats)
  return chats
}

function postChats(id, chats) {
  figma.ui.postMessage({ type: "chats", boardId: id, chats: chats })
}

// ------------------------------------------------------------------ messages

function selectionSummary() {
  return figma.currentPage.selection.slice(0, 20).map(describe)
}

figma.on("selectionchange", function () {
  figma.ui.postMessage({ type: "selection", selection: selectionSummary() })
  noteSelection()
})

// What the panel and the bridge use to tell boards apart. figma.fileKey is
// only exposed to private plugins, so it may be missing.
function fileInfo() {
  var key
  try {
    key = figma.fileKey
  } catch (error) {
    key = undefined
  }
  var link = boardUrl()
  return { name: figma.root.name, page: figma.currentPage.name, pageId: figma.currentPage.id, fileKey: key || undefined, url: link.url, urlHint: link.url ? undefined : link.hint, boardId: boardId() }
}

figma.on("currentpagechange", function () {
  watchPage()
  figma.ui.postMessage({ type: "page", file: fileInfo(), selection: selectionSummary() })
})

watchPage()

figma.ui.onmessage = async function (msg) {
  if (!msg || typeof msg !== "object") return
  if (msg.type === "resize") {
    resizeUI(clamp(msg.width, 200, 1400, 400), clamp(msg.height, 40, 1200, 640), msg.anchor === true)
    return
  }
  // Links in rendered replies open in the user's browser. Only web and mail
  // links; anything else is ignored.
  if (msg.type === "open-external") {
    if (typeof msg.url === "string" && /^(https?:|mailto:)/i.test(msg.url)) figma.openExternal(msg.url)
    return
  }
  if (msg.type === "init") {
    await startupReady
    var activeBoardId = boardId()
    var chats = []
    var problem = settingsLoadProblem
    try {
      chats = await loadChatIndex(activeBoardId)
    } catch (error) {
      problem = (problem ? problem + " " : "") + "Couldn't read saved chats: " + errorText(error)
    }
    figma.ui.postMessage({
      type: "init",
      settings: loadedSettings,
      selection: selectionSummary(),
      file: fileInfo(),
      boardId: activeBoardId,
      chats: chats,
      tools: toolSpecs,
      plugin: versionInfo(),
      figmaToken: figmaTokenStatus(await loadFigmaToken()),
      problem: problem,
    })
    return
  }
  if (msg.type === "save-settings") {
    loadedSettings = msg.settings || {}
    await figma.clientStorage.setAsync(SETTINGS_KEY, loadedSettings)
    return
  }
  // The Figma access token for the comment tools: stored here once, never
  // sent back. The reply carries only {hasToken, last4}.
  if (msg.type === "figma-token-save" || msg.type === "figma-token-clear") {
    var newToken = msg.type === "figma-token-save" && typeof msg.token === "string" ? msg.token.trim() : ""
    var tokenReply = { type: "figma-token" }
    try {
      if (msg.type === "figma-token-save") {
        if (!newToken) throw new Error("Paste a token first.")
        if (/[^\x21-\x7e]/.test(newToken)) throw new Error("That doesn't look like a Figma token (it has spaces or unusual characters).")
        await figma.clientStorage.setAsync(FIGMA_TOKEN_KEY, newToken)
      } else {
        await figma.clientStorage.deleteAsync(FIGMA_TOKEN_KEY)
      }
    } catch (error) {
      tokenReply.error = scrubToken(errorText(error), newToken)
    }
    Object.assign(tokenReply, figmaTokenStatus(await loadFigmaToken()))
    figma.ui.postMessage(tokenReply)
    return
  }
  if (msg.type === "chats-list" || msg.type === "chat-load" || msg.type === "chat-save" || msg.type === "chat-rename" || msg.type === "chat-delete") {
    var chatBoardId = boardId()
    try {
      if (msg.type === "chats-list") {
        postChats(chatBoardId, await loadChatIndex(chatBoardId))
      } else if (msg.type === "chat-load") {
        var chat = await figma.clientStorage.getAsync(chatKey(chatBoardId, String(msg.id || "")))
        figma.ui.postMessage({
          type: "chat",
          id: msg.id,
          chat: chat || null,
          error: chat ? undefined : "Chat not found: " + msg.id,
        })
      } else if (msg.type === "chat-save") {
        postChats(chatBoardId, await saveChat(chatBoardId, msg.chat))
      } else if (msg.type === "chat-rename") {
        postChats(chatBoardId, await renameChat(chatBoardId, String(msg.id || ""), msg.title))
      } else {
        postChats(chatBoardId, await deleteChat(chatBoardId, String(msg.id || "")))
      }
    } catch (error) {
      figma.ui.postMessage({ type: "chats-error", error: errorText(error) })
    }
    return
  }
  if (msg.type === "notify") {
    figma.notify(String(msg.text || ""), { timeout: 2500 })
    return
  }
  if (msg.type === "fetch-result") {
    var waiting = pendingFetches[msg.id]
    if (!waiting) return
    delete pendingFetches[msg.id]
    clearTimeout(waiting.timer)
    if (msg.ok) waiting.resolve(msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes))
    else waiting.reject(new Error(String(msg.error || "fetch failed")))
    return
  }
  if (msg.type === "tool") {
    var actor = typeof msg.actor === "string" ? msg.actor : undefined
    var writes = Boolean(tools[msg.name]) && !toolMeta[msg.name].readOnly
    var callCtx = { actor: actor }
    try {
      var result = await withPageLock(wantsPage(msg.name, msg.input), async function () {
        if (writes) currentCall = { actor: actor }
        var r = await runToolCall(msg.name, msg.input, callCtx)
        if (writes) figma.commitUndo()
        return r
      })
      var target = targetInfo(callCtx.page || figma.currentPage)
      if (isPlainObject(result)) result.target = target
      figma.ui.postMessage({ type: "tool-result", id: msg.id, ok: true, result: result, target: target })
    } catch (error) {
      var failure = { ok: false, code: errorCode(error), error: errorText(error), target: targetInfo(callCtx.page || figma.currentPage) }
      if (error && error.mismatches) failure.mismatches = error.mismatches
      var text = failure.code + ": " + failure.error
      if (failure.mismatches) text += " mismatches: " + JSON.stringify(failure.mismatches)
      text += " target: " + JSON.stringify(failure.target)
      figma.ui.postMessage({ type: "tool-result", id: msg.id, ok: false, error: text, code: failure.code, mismatches: failure.mismatches, target: failure.target, result: failure })
    } finally {
      if (writes) {
        currentCall = null
        lastCall = { actor: actor, endedAt: Date.now() }
      }
    }
  }
}
