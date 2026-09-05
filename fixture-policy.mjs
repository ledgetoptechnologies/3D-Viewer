// This allowlist authenticates only the bundled synthetic demonstration bytes.
// It is NOT an equivalence audit, converter receipt, or production trust policy.
export const FIXTURE_SHA256 = Object.freeze({
  '/fixtures/mesh/tileset.json': '67944349a8ca9d34f97761ec49368806e4a5cc6375b3eab8e72f1ddc458869c4',
  '/fixtures/mesh/root.b3dm': 'd2ca32cd00f2949e2628bc8331deee8eba8f79ad934b3f0ccd9de4ba9643c6e3',
  '/fixtures/mesh/LOD-0/Mesh.b3dm': 'f7260a8df79eef047c1b246fd954d89de60ab8e1f0e3f3eb6b3eb5a3b2bdeb54'
});
export const DEMO_CATALOG = Object.freeze([
  { id: 'mesh', title: 'Synthetic textured surface', tileset: '/fixtures/mesh/tileset.json' },
  { id: 'cloud', title: 'Synthetic point-cloud surface', generator: 'analytic-wave-grid-v1' }
]);
export function fixturePath(url, origin) {
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin || parsed.search || parsed.hash || !Object.hasOwn(FIXTURE_SHA256, parsed.pathname)) {
    throw new Error('Only the bundled synthetic mesh fixture is allowed');
  }
  return parsed.pathname;
}
export function syntheticCloud() {
  const positions = [], colors = [];
  for (let z = 0; z <= 100; z++) for (let x = 0; x <= 100; x++) {
    const px = x / 25 - 2, pz = z / 25 - 2;
    const py = 0.25 * Math.sin(px * 2) * Math.cos(pz * 2);
    positions.push(px, py, pz);
    colors.push(0.85, 0.35 + (py + 0.25) * 0.7, 0.12);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
}
