import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('mouse navigation profiles use an accessible side-by-side pressed-state toggle', () => {
  assert.match(html, /id="mouse-profile-toggle" role="group" aria-labelledby="mouse-profile-label"/);
  assert.match(html, /id="mouse-profile-default"[^>]*data-mouse-profile="default"[^>]*aria-pressed="true"/);
  assert.match(html, /id="mouse-profile-alternate"[^>]*data-mouse-profile="alternate"[^>]*aria-pressed="false"/);
  assert.match(html, /#mouse-profile-toggle\s*\{\s*display:flex/);
  assert.match(runtime, /button\.classList\.toggle\('active',selected\)/);
  assert.match(runtime, /button\.setAttribute\('aria-pressed',String\(selected\)\)/);
  assert.match(runtime, /viewerPreferences\.change\(\{mouseProfile:button\.dataset\.mouseProfile\}\)/);
});
