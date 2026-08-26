export const CAMERA_MARKER_COLORS = Object.freeze({
  body: 0xEE5007,
  bodyHover: 0xF8CB2E,
  direction: 0xF8CB2E,
  directionHover: 0xFFFFFF,
});

export function cameraMarkerGeometryData() {
  const w = 0.55;
  const h = 0.41;
  const imagePlaneZ = 0.72;
  const body = [
    0, 0, 0, -w, -h, imagePlaneZ, w, -h, imagePlaneZ,
    0, 0, 0, w, -h, imagePlaneZ, w, h, imagePlaneZ,
    0, 0, 0, w, h, imagePlaneZ, -w, h, imagePlaneZ,
    0, 0, 0, -w, h, imagePlaneZ, -w, -h, imagePlaneZ,
    -w, -h, imagePlaneZ, w, -h, imagePlaneZ, w, h, imagePlaneZ,
    -w, -h, imagePlaneZ, w, h, imagePlaneZ, -w, h, imagePlaneZ,
  ];

  const aw = 0.18;
  const ah = 0.14;
  const tipZ = 1.8;
  const direction = [
    -aw, -ah, imagePlaneZ, aw, -ah, imagePlaneZ, 0, 0, tipZ,
    aw, -ah, imagePlaneZ, aw, ah, imagePlaneZ, 0, 0, tipZ,
    aw, ah, imagePlaneZ, -aw, ah, imagePlaneZ, 0, 0, tipZ,
    -aw, ah, imagePlaneZ, -aw, -ah, imagePlaneZ, 0, 0, tipZ,
    -aw, -ah, imagePlaneZ, aw, ah, imagePlaneZ, aw, -ah, imagePlaneZ,
    -aw, -ah, imagePlaneZ, -aw, ah, imagePlaneZ, aw, ah, imagePlaneZ,
  ];

  return { body, direction };
}
