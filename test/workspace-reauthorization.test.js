const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');

test('expired workspaces use a fixed Operations reauthorization bounce with same-browser replay protection', () => {
  assert.match(source, /\/viewer\/reauthorize\?state=/);
  assert.match(source, /crypto\.randomUUID\(\)\.replaceAll\('-',''\)/);
  assert.match(source, /Date\.now\(\)-pending\.createdAt<=5\*60\*1000/);
  assert.match(source, /pending\?\.nonce===value/);
  assert.match(source, /sessionStorage\.removeItem\(REAUTH_STATE_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(OPS_ORIGIN_KEY,checked\.controllerOrigin\)/);
  assert.match(source, /parsed\.protocol==='https:'&&parsed\.origin===value/);
  assert.doesNotMatch(source, /return(?:Url|_url)=/);
});
