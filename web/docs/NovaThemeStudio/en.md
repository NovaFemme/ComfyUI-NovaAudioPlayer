# Nova Theme Studio 🎨

Recolours the ComfyUI interface from one palette, live on the canvas, and can
put a wallpaper behind the graph. The node is a control panel: it has no inputs
and no outputs, is never executed, and nothing it does is sent to the backend.

## The theme is global

This is the first thing to know. The theme is **not** per node and **not** per
workflow:

- It applies to **every node from every pack**, not only the Nova nodes, and to
  ComfyUI's own menus and dialogs.
- It is applied on **every page load**, whether or not a Theme Studio node is
  on the canvas. Deleting the node does not remove the theme.
- To go back, press **Reset** on the node, or pick one of ComfyUI's own themes
  under Settings → Appearance.

## Themes and finishes

Six themes — **Midnight**, **Ember**, **Nova**, **Forest**, **Slate** and
**Ultraviolet** — each at four finishes:

| Finish | Node body | What it is for |
|---|---|---|
| **Solid** | opaque | The safe choice. Every label is readable over anything. |
| **Tinted** | see-through, opaque widgets | A hint of the canvas through the node. |
| **Frosted** | see-through, washed widgets | More of the wallpaper shows. |
| **Glass** | see-through, lightly washed widgets | The most transparent finish. |

Under **Glass** and **Frosted**, text sits over whatever is behind the node. A
wallpaper with bright areas needs help: when you choose Glass or Frosted with a
wallpaper set and both `blur` and `dim` still at 0, the studio sets `blur` to
12 and `dim` to 0.3 for you. Both sliders stay yours to change afterwards.

## The other rows

| Row | Options | What it does |
|---|---|---|
| **theme studio** | Enabled / Disabled | The master switch. *Disabled* applies nothing at all: no palette, no wallpaper, no see-through nodes. Everything the studio wrote is taken back and the palette chosen in ComfyUI's own Settings is shown, as on a stock install. Your theme is kept, and can still be edited while disabled; *Enabled* puts it back without a reload. Also `novaTheme.enabled(false)` in the browser console. |
| **renderer** | Auto / Classic / Nodes 2.0 | How the studio treats the nodes. Leave it on *Auto*; the other two are for when the probe reads the renderer wrongly. |
| **top panel** | Always shown / Collapsible | *Collapsible* puts a fold button on the title bar of nodes that have a panel of their own. Folding hides the slots and widget rows above the panel. Nodes 2.0 only. |

Below the rows, every colour of the palette can be edited one by one, each with
an alpha slider. The search box and the section list narrow what is shown.

## Wallpaper

Under **canvas & backdrop**:

| Field | What it does |
|---|---|
| `image` | A file in `ComfyUI/input`, or a URL. |
| `fit` | How the image fills the canvas. |
| `blur` | Blurs the wallpaper, 0–40 px. |
| `dim` | Darkens the wallpaper, 0–0.9. |
| `hideGrid` | Hides the canvas grid over the wallpaper. |
| `node opacity` | Fades whole nodes, text included. For see-through nodes use a finish instead; those keep the text crisp. |

**A URL is fetched by your browser** each time the page loads, from whatever
server it names. Use a file in `ComfyUI/input` if you do not want that.

## Saving and sharing

| Button | What it does |
|---|---|
| **Reset** | Back to the palette as it was when this tab opened. |
| **Copy** | Copies the theme as JSON to the clipboard. |
| **Load** | Loads a theme JSON from a file. |
| **Save as** | Saves the palette under the name you typed into ComfyUI's own custom themes, so it appears in Settings → Appearance. |
| **Download** | Downloads the theme as `<name>.json`. |

## What it stores, and where

- Your palette, wallpaper settings and choices are kept in the browser's local
  storage, under the key `Nova.ThemeStudio`. They are per browser, not per
  workflow.
- **Save as** writes to ComfyUI's custom colour palettes setting. Nothing else
  writes to ComfyUI's settings, and only when you press the button.
- The wallpaper and the finishes are not part of a ComfyUI theme file; a theme
  saved with **Save as** carries the colours only.

## Classic and Nodes 2.0

The Classic renderer paints nodes on a canvas; Nodes 2.0 builds them from page
elements. The studio handles both, and a few things differ:

- The fold button exists in Nodes 2.0 only.
- Under Glass, Nodes 2.0 gives node bodies and widget fields a faint wash, so
  fields keep a visible box. Classic cannot draw a partly transparent body, so
  there a Glass body is fully transparent.
