import test from 'node:test';
import assert from 'node:assert/strict';
import {adminCalculationRequest,priorMeterDeclaration} from '../measurement-admin-dialog.mjs';

test('point calculation leaves encoded units to server without inventing a meter declaration',()=>{
  const record={id:'one',kind:'polygon',revision:2},sources=[{assetId:'cloud',kind:'ept',methods:['point-surface-cut-fill']}];
  const body=adminCalculationRequest(record,{sourceAssetId:'cloud',method:'point-surface-cut-fill',reference:'boundary-triangulated',offsetM:0,cellSizeM:.1,classFilter:'all',confirmMeters:false},sources);
  assert.equal(Object.hasOwn(body,'sourceVerticalUnit'),false);assert.equal(body.cellSizeM,.1);
});
test('reuse staff declaration only for exact measurement/version/source file and EPT closure',()=>{
  const record={id:'one',modelVersionId:'version'},source={assetId:'cloud',kind:'ept',modelVersionId:'version',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
  const job={measurementId:'one',status:'complete',method:'point-surface-cut-fill',parameters:{sourceAssetId:'cloud',sourceVerticalUnit:'m'},result:{source:{...source,verticalUnit:'m',verticalUnitBasis:'administrator-declared'}}};
  job.result.source.assetId=source.assetId;
  assert.equal(priorMeterDeclaration(record,source,[job]),true);
  for(const modify of [j=>j.measurementId='other',j=>j.status='failed',j=>j.result.source.sha256='c'.repeat(64),j=>j.result.source.manifestSha256='c'.repeat(64),j=>j.result.source.modelVersionId='other',j=>j.result.source.verticalUnitBasis='ept-vertical-crs',j=>j.parameters.sourceVerticalUnit=null]){
    const invalid=structuredClone(job);modify(invalid);assert.equal(priorMeterDeclaration(record,source,[invalid]),false);
  }
  assert.equal(priorMeterDeclaration(record,{...source,sha256:undefined},[job]),false);
  assert.equal(priorMeterDeclaration(record,{...source,modelVersionId:'other'},[job]),false);
  assert.equal(priorMeterDeclaration(record,source,[]),false);
});
