'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('dev publication preserves production tag scope and all exact-image verification gates',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../.github/workflows/viewer-image.yml'),'utf8');
  assert.match(source,/branches: \[main, dev\]/);
  assert.match(source,/flavor:\s*\|\s*latest=false/);
  assert.match(source,/type=raw,value=latest,enable=\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(source,/type=raw,value=dev,enable=\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev' \}\}/);
  const check=source.indexOf('name: Run checks'),build=source.indexOf('name: Build isolated candidate'),verify=source.indexOf('name: Verify exact candidate image'),promote=source.indexOf('name: Promote verified digest');
  assert.ok(check>=0&&build>check&&verify>build&&promote>verify);
  assert.match(source,/PUBLISHED_IMAGE:.*@\$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(source,/viewer-image-attestation-\$\{\{ github\.sha \}\}/);
  assert.equal([...source.matchAll(/EXPECTED_SCHEMA_VERSION: "39"/g)].length,2);
});
