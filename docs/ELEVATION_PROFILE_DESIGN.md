# Elevation profile / cross-section interaction

Status: the volume inspector now implements a **reduced-sample corridor preview**
with linked plan/chart inspection. The native-resolution line-profile feature
described below remains a proposed follow-up, not a completed feature.
The user's September 6 example clarifies that “cut line” means a sampled height
profile across a pile, not the orthophoto footprint download or volume base plane.

## Relevant references

- [Pix4D elevation profiles](https://www.pix4d.com/blog/elevation-profile): a DSM-backed line in map/3D view opens a bottom chart, with linked chart/map hover and CSV export.
- [DroneDeploy elevation tools](https://help.dronedeploy.com/hc/en-us/articles/1500004964002-Elevation): line measurements expose elevation profiles and slope information; distinguish DSM from terrain-only DTM.
- [Site Scan 2024 release recap](https://www.esri.com/arcgis-blog/products/site-scan/imagery/site-scan-in-review-2024): documents elevation-profile measurements in the mesh view.
- [ArcGIS elevation-profile interaction](https://doc.arcgis.com/en/arcgis-online/get-started/scene-elevation-profile.htm): editable multi-segment lines and separately identified elevation sources. This is an interaction reference, not a dependency or a claim about Site Scan's exact current implementation.

## Proposed Viewer behavior

### Implemented volume-inspector subset (September 6 follow-up)

Finishing a polygon first saves its geometry, then opens the surface inspector
and requests the existing authorized browser/native-raster calculation. It does
not grant processing permission or start a server processing job. Missing source
or unverified vertical units remain explicit errors; unit confirmation is never
automatically checked.

The inspector filters the calculation's retained preview samples into an explicit
direction/position/width corridor. The initial position uses an observed sample
row; subsequent empty corridors remain empty. Hover and keyboard inspection show
station, top elevation, reference elevation, difference, and source coordinates,
linked to a plan-view marker. Samples are drawn as discrete points: no invented
curve through unsampled cells or NoData. Full native-cell integration remains the
volume result; the preview is neither its numerical input nor a continuous
terrain profile. A true native-resolution transect/cloud section and its profile
CSV export are still separate work.

### Remaining full-profile design

1. Add **Elevation profile** alongside Distance and Polygon. Click successive
   points across the pile, with the same live preview, Shift-to-navigate,
   Backspace undo, vertex editing and Finish behavior as other measurements.
2. Open a resizable bottom dock, retaining most of the map/model. The horizontal
   axis is cumulative horizontal distance along the selected line; vertical axis
   is elevation. Default feet; metric available. Always label the datum if known,
   or say “source elevation; vertical datum unverified.”
3. Hover or keyboard-step along the chart to show a linked marker on the line,
   station/distance, elevation, coordinate and local slope. Show gaps for NoData;
   never bridge them with invented surface heights. Display sample spacing.
4. Permit a DSM/DTM comparison when both are actually available and aligned.
   Default DSM for the visible pile surface. A generic DTM can remove a stockpile
   as a non-ground object: do not silently use it as the pile top or assume it
   is an observed concrete-pad base.
5. Label and save the profile privately per signed-in person and exact model
   version, as with current measurements. Public links keep it in memory only.
   Export CSV sample data and a PNG/PDF view with units, source and spacing.
6. For a selected volume polygon, optionally draw a section through that region
   and overlay the **same** reference surface used by the volume calculation.
   Shade above/below base, without implying that the area of one section is the
   complete pile volume. The full polygon integration remains authoritative.

## Data and performance requirements

- An orthophoto is an image, not a height source. Its profile must explicitly use
  a registered DSM/DTM; otherwise the feature is unavailable.
- Initial implementation should sample immutable native-resolution raster data
  with correct units, bounded reads and cancellation. Limit interactive chart
  samples, disclose spacing and use a defined downsampling policy that retains
  local extrema. Do not present interpolated display points as extra accuracy.
- Keep the chosen source stable between the 3D model and point-cloud views so
  the same saved profile does not change because different visible LOD loaded.
- A true point-cloud section like the example is a separate mode: extract points
  inside a narrow corridor of explicit width, project them to station/elevation,
  and label density/coverage. A cloud can have several heights at one station;
  do not collapse those to a single curve without naming the selection method.
- Do not perform a full-cloud GPU pick/readback for every chart hover. Hover uses
  already sampled data and updates one marker. No new client processing authority.
- Mesh sampling requires its own declared source resolution/coverage; missing
  mesh detail must not silently become a precise-looking continuous surface.

## Acceptance checks before implementation is called complete

Known flat plane, ramp, ridge and two-pile fixtures; exact endpoints and stations;
multi-segment distance; NoData breaks; metre/foot/survey-foot conversion; source
version/identity isolation; cancel during reads; no stale cross-view result;
linked pointer/keyboard hover; exports matching sample values; resizable desktop
and narrow-screen dock; frame responsiveness with a populated point cloud.

The supplied screenshot is sufficient to design this interaction. More examples
would be useful specifically for the desired cloud corridor width and whether
the user prefers all sampled points, a top-surface curve, or both.
