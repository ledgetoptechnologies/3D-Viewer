import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FIXTURE_SHA256 } from '../fixture-policy.mjs';
export async function verifyFixtures() {
  for (const [name, expected] of Object.entries(FIXTURE_SHA256)) {
    const data = await readFile(new URL(`../public${name}`, import.meta.url));
    if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`Synthetic fixture changed: ${name}`);
  }
  return Object.keys(FIXTURE_SHA256).length;
}
await verifyFixtures();
