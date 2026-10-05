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

test('changing dataset views preserves the selected mouse-profile highlight', () => {
  const block = runtime.match(/state\.activeMode = mode;\s*(document\.querySelectorAll\([\s\S]+?\r?\n  \}\);)/);
  assert.ok(block, 'execute the actual view-tab selection block');
  const makeButton = (dataset, active) => ({
    dataset,
    active,
    classList: { toggle(name, enabled) { assert.equal(name, 'active'); this.owner.active = enabled; } },
  });
  const buttons = [
    makeButton({ mode: 'model' }, true),
    makeButton({ mode: 'cloud' }, false),
    makeButton({ mouseProfile: 'default' }, false),
    makeButton({ mouseProfile: 'alternate' }, true),
  ];
  for (const button of buttons) button.classList.owner = button;
  const document = { querySelectorAll(selector) {
    if (selector === '.tab-btn') return buttons;
    assert.equal(selector, '.tab-btn[data-mode]');
    return buttons.filter(button => 'mode' in button.dataset);
  } };
  new Function('document', 'mode', block[1])(document, 'cloud');
  assert.deepEqual(buttons.map(button => button.active), [false, true, false, true]);
});
