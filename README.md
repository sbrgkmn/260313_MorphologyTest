# Morphology Test - Roof Ridge Generator

Interactive Three.js viewer that generates branching roof-ridge morphologies from a numeric seed.

## What It Does

- Builds a procedural ridge network with deterministic randomness (seeded generation).
- Grows the main branch unidirectionally along the initial axis.
- Adds side branches perpendicular to the active branch direction.
- Rejects branch centerlines that intersect existing branches (except shared endpoints).
- Builds roof surfaces and resolves branch joints with offset-line intersections for cleaner closure.

## Run Locally

Requirements:

- Node.js (for dependencies)
- Python 3 (for local static server)

Install dependencies:

```bash
npm install
```

Start server:

```bash
npm run serve
```

Open:

- http://127.0.0.1:8137/

## Controls

- Mouse:
  - Left drag: orbit
  - Right drag: pan
  - Wheel: zoom
- Keyboard:
  - `Space`: randomize seed
- UI:
  - `Randomize`, `Regenerate`, `Sample x12`
  - Toggles for ridge lines and surfaces
  - Sliders for depth, length/height/width decay, split chance, and geometry scale

## Key Files

- `index.html` - UI shell and import map
- `src/main.js` - generation + geometry logic
- `src/style.css` - panel and scene styling

