# Building plans in SVG

A building can be drawn as a plan, seen from above, in any SVG editor or by an agent, and built into a world (Track P's P.01, dp-007). The plan says what each shape is; the builder turns it into the world's scene, with its solids, its light baked in and its spawn points. The plan is the source: [kits/worlds/docking-bay/plan.svg](../kits/worlds/docking-bay/plan.svg) is a complete one.

```sh
node tools/converter/scripts/build-plan.ts kits/worlds/docking-bay/plan.svg
```

This writes `world.toml` and `scenes/docking-bay.glb` beside the plan, a world folder that the validator and the host tool's converter take like any other ([world-format.md](world-format.md)).

## The page

- **The root.** The `<svg>` carries `data-flatchat-plan="1"`, a `data-name` and a `data-description` for the world.
- **Scale.** `data-scale` is how many metres one unit of the page is (1 when left out; the docking bay uses 0.1, so 10 cm a unit).
- **Directions.** The page's x is the world's x. Down the page is the world's +z, so up the page is north, the way a spawned player faces at 0°.
- **Shapes.** A plan is straight lines: `rect`, `line`, `polyline`, `polygon`, `circle` (a marker: its centre) and `path` with M, L, H, V and Z. A curve is refused, with where it is.
- **Transforms.** Transforms on groups and shapes apply: translate, rotate, scale and matrix.
- **Everything else** (fills, strokes, text, other elements) is for whoever reads the plan; the builder ignores it.

## Floors

Each floor is a layer: `<g class="floor">` with these attributes.

| Attribute | Meaning |
|---|---|
| `id` | the floor's name |
| `data-elevation` | its height above the ground, in metres (0) |
| `data-height` | how high its walls go, in metres (3) |
| any other `data-…` | a default for the shapes in it (a floor's `data-material="hull"` makes its walls hull) |

Heights, thicknesses and elevations are always metres, whatever the page's scale.

## Shapes

A shape says what it is with its class.

| Class | Drawn as | Attributes (metres; defaults) |
|---|---|---|
| `slab` | a closed shape | `data-material` (deck, pad, ceiling, space), `data-top` above the floor (0), `data-thickness` below that (0.2) |
| `wall` | a line, polyline, polygon or rect: its centre line | `data-thickness` (0.2), `data-wall-height` (the floor's), `data-material` (panel, hull, space) |
| `opening` | a line along a wall | `data-sill` (0) and `data-head` (2.4): a door, a window, a bay |
| `stairs` | a rect | `data-up` (degrees clockwise from up the page, the way up), `data-rise` (the floor's height), `data-steps` (one per 20 cm) |
| `strip` | a line or polyline | a neon strip: `data-y` (2.6), `data-size` (0.08), `data-colour` (#rrggbb) |
| `prop` | a circle | `data-part` (a base library part, such as `flatchat:crate`), `data-rotate` (degrees clockwise), `data-y` (stacking) |
| `light` | a circle | `data-y` above the floor, `data-colour`, `data-intensity` (1), `data-range` (8) |
| `spawn` | a circle | `data-facing` (degrees clockwise from up the page), `data-title`, `data-group` |

Openings, stairs and markers:

- **Openings.** An opening lies on its wall's centre line, within the wall's thickness, and cuts the wall: below its sill and above its head the wall stays.
- **Space.** A slab or wall of `space` glows with stars and stops nothing. It is the view out of a bay window; keep it within 40 m of where players stand, or the client's fog greys it.
- **Problems.** Every problem in a plan is reported at once, with the element it is about.

## What the builder makes

- **Walls.** Each wall is a run of mitered pieces, cut around its openings. Every piece is a solid box, and its faces carry the trim sheet in bands by height: a kick plate with hazard stripes at the foot, then hull or panel plates up the wall.
- **Slabs.** A slab's top is deck plate, the landing pad its own markings, and an upper floor's underside shows from below. A rectangular slab is a box solid; any other is a triangle-mesh solid.
- **Stairs and strips.** Stairs are steps, each a solid. Strips glow in their colour, and each light shows as a small glowing panel.
- **Light.** The plan's lights are baked into the vertex colours, over a little ambient light, with the shadows of walls, steps and slabs. Faces are cut into cells of a metre so the light is smooth.
- **Props and spawns.** Props are the base library's parts, placed by the world (nothing to download). Spawn points face the way the plan says.
- **One mesh per material.** The trim sheet, the deck, the ceiling, the pad, space and each neon colour are a mesh each, so a building draws in about a dozen calls. The converter adds levels of detail to the larger meshes.

The textures are drawn by the builder from a seeded generator, so a plan builds to the same bytes every time and nothing in it needs a licence. The docking bay is 16,556 triangles in 11 materials; built with KTX2 textures, the whole world is 322 KB.

## Previews

The same plan can be drawn as an isometric cut-away, its walls cut 1.5 m above each floor, by either of two picture-making skills:

- **anatomy:** `--with anatomy`, with the skill's folder (github.com/wheresryan22/anatomy).
- **iso-figures:** `--with iso-figures`, with the owner's skill folder.

```sh
node tools/converter/scripts/plan-preview.ts kits/worlds/docking-bay/plan.svg --with anatomy --kit DIR --out preview.html
```

They are previews, never the plan's source. The spike report compares them: [spikes/s-svg.md](spikes/s-svg.md).
