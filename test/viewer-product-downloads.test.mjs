import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sessionProductsUrl,safeProductTicket} from '../viewer-product-downloads.mjs';

test('product endpoint is derived only from known same-origin scoped asset URLs',()=>{
  const origin='https://viewer.test';
  assert.equal(sessionProductsUrl('/session-assets/token/model/models/a.glb',origin),'/session-products/token/model');
  assert.equal(sessionProductsUrl('https://viewer.test/session-assets/share.signature/model/webodm/a.tif',origin),'/session-products/share.signature/model');
  assert.equal(sessionProductsUrl('https://evil.test/session-assets/token/model/models/a.glb',origin),null);
  assert.equal(sessionProductsUrl('/assets/model/models/a.glb',origin),null);
  assert.equal(sessionProductsUrl('',origin),null);
});
test('download navigation accepts only narrow opaque same-origin product tickets',()=>{
  const origin='https://viewer.test',token='a'.repeat(43),path=`/session-product-downloads/${token}`;
  assert.equal(safeProductTicket(path,origin),origin+path);
  for(const bad of ['https://evil.test'+path,path+'?token=broad',path+'#secret','javascript:alert(1)','/session-assets/broad/model/file',path+'/child'])assert.equal(safeProductTicket(bad,origin),null);
});
test('viewer products keep sources out of browser heaps and recheck permission before download',()=>{
  const source=readFileSync(new URL('../viewer-product-downloads.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.blob\(|createObjectURL|innerHTML\s*=/);
  assert.match(source,/!allowed\(\).*epoch !== generation/);
  assert.match(source,/link\.referrerPolicy = 'no-referrer'/);
  assert.match(source,/controller\?\.abort\(\)/);
});
