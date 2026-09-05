# DSM/DTM viewing controls

Elevation overlays now start at 100% opacity; Reset to defaults restores Viridis,
shading 1.0, automatic min/max range, continuous colors and 100% opacity.
Palette and color-band selections apply immediately. Shading and min/max edits
debounce for 180 ms. Expensive overview redraws are serialized; obsolete results
cannot overwrite the latest chosen colors. The Apply button is removed.

Min/max remap the elevation color scale, not point or raster visibility. Valid
elevations outside the chosen range remain visible in the nearest endpoint color.
Blank bounds use the raster's automatic range. Inputs and legend follow session
units (feet converted to meters internally, metric input unchanged). Both DEM
pixel-rendering paths use alpha 255 for valid pixels, so 100% opacity is genuinely
opaque; invalid/no-data pixels remain transparent.

DSM and DTM use the same source-anchored camera-position map overlay as orthophoto,
including camera permissions, original-photo preview behavior and marker size.

Surface and Reference selectors are volume measurement controls, not color
settings. They are hidden during normal DSM/DTM browsing and shown when Volume is
selected. Their original surface/reference selection and numerical integration
remain intact. They remain available on orthophoto as before.

Local checks: `node --test test/dem-settings-ui.test.mjs test/map-volume.test.mjs`
and `npm run build`. Real-data browser retest should change palette/steps during
loading, drag shading rapidly, reset, verify 100% opacity, toggle camera positions
on each map, and confirm Volume reveals its reference settings.
