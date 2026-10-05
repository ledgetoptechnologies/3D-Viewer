import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementMassSummary} from '../measurement-density-dialog.mjs';
import {
  normalizeMeasurementDensity, estimateMeasurementMass, estimateMeasurementInventory, measurementInventoryUnavailableReason,
  KILOGRAMS_PER_POUND, CUBIC_METRES_PER_CUBIC_FOOT, CUBIC_FEET_PER_CUBIC_YARD,
} from '../measurement-density.mjs';

const cubicYardM3 = CUBIC_METRES_PER_CUBIC_FOOT * CUBIC_FEET_PER_CUBIC_YARD;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} differs from ${expected}`);
const af = {value:48.40, unit:'lb/ft3', basis:'as_fed'};
const enclosureChecks = {closed:true,edgeManifold:true,vertexManifold:true,orientationConsistent:true,selfIntersections:false};
const enclosed = (volumeM3, extra={}) => ({volumeM3,method:'closed-mesh',status:'complete',checks:{...enclosureChecks},...extra});

test('density cards expose missing coverage reasons instead of silent or plausible mass',()=>{
  assert.equal(measurementMassSummary({results:{cutM3:1}}),'');
  assert.match(measurementMassSummary({materialDensity:af,results:{cutM3:1,status:'complete'}}),/100% numeric surface coverage/);
  assert.match(measurementMassSummary({materialDensity:af,results:{cutM3:1,status:'cancelled',coverage:1}}),/calculate a current material volume/);
  assert.match(measurementMassSummary({materialDensity:af,results:{cutM3:cubicYardM3,status:'complete',coverage:1}}),/Estimated as-fed: 0\.653 US short tons/);
});

test('owner supplied above-base sample keeps cut and independent density bases distinct', () => {
  // Units are explicit for this numerical fixture, not verified source evidence.
  const results = {cutM3:175231.590 * CUBIC_METRES_PER_CUBIC_FOOT,
    fillM3:77.330 * CUBIC_METRES_PER_CUBIC_FOOT,
    netM3:175154.261 * CUBIC_METRES_PER_CUBIC_FOOT, coverage:1, status:'complete'};
  const inventory = estimateMeasurementInventory({results, materialDensity:af});
  close(inventory.asFed.usShortTons, 4240.604478);
  close(inventory.volumeM3 / cubicYardM3, 6490.058888888889);
  const dry = estimateMeasurementInventory({results, materialDensity:{value:17.22,unit:'lb/ft3',basis:'dry_matter'}});
  close(dry.dryMatter.usShortTons, 1508.7439899);
  assert.equal(dry.asFed,null);
  assert.equal(inventory.dryMatter,null);
});

test('one cubic yard with 48.40 lb/ft3 produces 0.6534 US short tons as-fed', () => {
  const result = estimateMeasurementMass(cubicYardM3, af);
  close(result.asFed.pounds, 1306.8);
  close(result.asFed.usShortTons, 0.6534);
  close(result.asFed.kilograms, 1306.8 * KILOGRAMS_PER_POUND);
  close(result.asFed.metricTonnes, result.asFed.kilograms / 1000);
  assert.equal(result.asFed.basis, 'as_fed');
  assert.equal(result.dryMatter, null);
});

test('one cubic yard with 17.22 lb/ft3 DM density retains the DM basis', () => {
  const result = estimateMeasurementMass(cubicYardM3, {value:17.22, unit:'lb/ft3', basis:'dry_matter'});
  close(result.dryMatter.usShortTons, 0.23247);
  assert.equal(result.dryMatter.basis, 'dry_matter');
  assert.equal(result.asFed, null);
});

test('density units are equivalent without rounding loss', () => {
  const imperial = estimateMeasurementMass(125, af);
  const metric = estimateMeasurementMass(125, {...af, value:48.4 * KILOGRAMS_PER_POUND / CUBIC_METRES_PER_CUBIC_FOOT, unit:'kg/m3'});
  close(imperial.asFed.kilograms, metric.asFed.kilograms);
  close(metric.densityKgM3 * CUBIC_METRES_PER_CUBIC_FOOT / KILOGRAMS_PER_POUND, af.value);
});

test('explicit DM percentage converts both ways and allows 100 percent', () => {
  const result = estimateMeasurementMass(10, {value:600, unit:'kg/m3', basis:'as_fed', dryMatterPercent:35});
  close(result.asFed.kilograms, 6000);
  close(result.dryMatter.kilograms, 2100);
  assert.equal(result.derivedBasis,'dry_matter');
  const reverse = estimateMeasurementMass(10, {value:210, unit:'kg/m3', basis:'dry_matter', dryMatterPercent:35});
  close(reverse.asFed.kilograms, result.asFed.kilograms);
  assert.equal(reverse.derivedBasis,'as_fed');
  close(reverse.dryMatter.kilograms, result.dryMatter.kilograms);
  const dry = estimateMeasurementMass(10, {...af, dryMatterPercent:100});
  assert.equal(dry.asFed.kilograms, dry.dryMatter.kilograms);
});

test('absence creates no assumption; zero volume creates zero mass', () => {
  assert.equal(normalizeMeasurementDensity(undefined), null);
  assert.equal(estimateMeasurementMass(10, null), null);
  assert.equal(estimateMeasurementMass(undefined, undefined), null);
  assert.equal(estimateMeasurementMass(0, af).asFed.kilograms, 0);
});

test('normalization keeps only supplied provenance and does not mutate input', () => {
  const input = {...af, sourceNote:'  Client core samples  ', sampledOn:'2024-02-29', unknown:'discarded'};
  const before = structuredClone(input);
  assert.deepEqual(normalizeMeasurementDensity(input), {...af, sourceNote:'Client core samples', sampledOn:'2024-02-29'});
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeMeasurementDensity(af), af);
});

test('invalid numeric, unit and basis inputs are rejected', () => {
  for (const value of [0, -1, NaN, Infinity, '48.4', null]) assert.throws(() => normalizeMeasurementDensity({...af, value}));
  for (const value of [0, -1, NaN, Infinity, 101, '35']) assert.throws(() => normalizeMeasurementDensity({...af, dryMatterPercent:value}));
  for (const input of [false, [], '48.4', {...af, unit:'tons/yd3'}, {...af, basis:undefined}, {...af, basis:'wet'}]) assert.throws(() => normalizeMeasurementDensity(input));
  for (const volume of [-1, NaN, Infinity, '10', null]) assert.throws(() => estimateMeasurementMass(volume, af));
});

test('provenance text and sampling dates are bounded and calendar-validated', () => {
  assert.throws(() => normalizeMeasurementDensity({...af, sourceNote:'a'.repeat(501)}));
  assert.throws(() => normalizeMeasurementDensity({...af, sourceNote:42}));
  for (const sampledOn of ['2023-02-29', '2026-04-31', '2026-13-01', '6.19.26', 20260619]) assert.throws(() => normalizeMeasurementDensity({...af, sampledOn}));
  assert.equal(normalizeMeasurementDensity({...af, sourceNote:'a'.repeat(500)}).sourceNote.length, 500);
});

test('overflow fails visibly instead of emitting infinite estimates', () => {
  assert.throws(() => estimateMeasurementMass(Number.MAX_VALUE, af));
  assert.throws(() => estimateMeasurementMass(0, {...af, value:Number.MAX_VALUE}));
  assert.throws(() => estimateMeasurementMass(1, {value:Number.MAX_VALUE, unit:'kg/m3', basis:'dry_matter', dryMatterPercent:1}));
});

test('inventory uses above-base cut rather than net and falls back to enclosed volume', () => {
  const pile = {materialDensity:af, results:{cutM3:cubicYardM3, netM3:0, fillM3:cubicYardM3, volumeM3:999, coverage:1, status:'complete'}};
  close(estimateMeasurementInventory(pile).asFed.usShortTons, .6534);
  assert.equal(estimateMeasurementInventory(pile).volumeBasis, 'cut_above_base');
  assert.equal(estimateMeasurementInventory({...pile,results:enclosed(1)}).volumeBasis, 'enclosed_object');
  assert.equal(estimateMeasurementInventory({...pile,results:{cutM3:0,coverage:1,status:'calculated'}}).asFed.kilograms, 0);
});

test('inventory never reuses invalidated, geometry-only or historical volumes', () => {
  for (const results of [undefined, {netM3:10}, {previousVolume:{cutM3:10}}, {cutM3:10,volumeInvalidated:true}, {cutM3:10,status:'geometry-only'}, {volumeM3:10,status:'failed'}, {volumeM3:10,status:'calculating'}]) {
    assert.equal(estimateMeasurementInventory({materialDensity:af,results}), null);
  }
  assert.equal(estimateMeasurementInventory({results:{cutM3:10}}), null);
});

test('partial or historical quantities cannot establish whole-pile inventory', () => {
  for (const results of [{cutM3:10,status:'incomplete'},{cutM3:10,coverage:.99},{volumeM3:10,status:'historical'},{cutM3:10,coverage:NaN},{cutM3:10,coverage:1.1}]) assert.equal(estimateMeasurementInventory({materialDensity:af,results}),null);
  assert.ok(estimateMeasurementInventory({materialDensity:af,results:{cutM3:10,coverage:1,status:'complete'}}));
});

test('unconvertible density rejects normalization and legacy overflow inventory is unavailable', () => {
  assert.throws(()=>normalizeMeasurementDensity({...af,value:Number.MAX_VALUE}));
  assert.equal(estimateMeasurementInventory({materialDensity:af,results:{cutM3:Number.MAX_VALUE}}),null);
  assert.equal(estimateMeasurementInventory({materialDensity:{...af,value:Number.MAX_VALUE},results:{cutM3:1}}),null);
});

test('surface inventory fails closed without completed status and full numeric coverage', () => {
  const current={cutM3:10,status:'complete',coverage:1};
  for(const status of [undefined,null,'','cancelled','running','queued','estimate','unexpected']) {
    const record={materialDensity:af,results:{...current,status}};
    assert.equal(estimateMeasurementInventory(record),null);
    assert.match(measurementInventoryUnavailableReason(record),/current material volume|completed surface calculation/);
  }
  for(const coverage of [undefined,null,'1','0.5',NaN,Infinity,-Infinity,0,.999,1.001]) {
    const record={materialDensity:af,results:{...current,coverage}};
    assert.equal(estimateMeasurementInventory(record),null);
    assert.match(measurementInventoryUnavailableReason(record),/100% numeric surface coverage/);
  }
  for(const status of ['complete','calculated']) assert.ok(estimateMeasurementInventory({materialDensity:af,results:{...current,status}}));
});

test('invalid surface evidence cannot fall through to enclosed volume', () => {
  for(const results of [{cutM3:-1,volumeM3:10,status:'complete',coverage:1},{cutM3:10,volumeM3:20,status:'complete'},{cutM3:null,volumeM3:20,status:'complete',coverage:1}]) assert.equal(estimateMeasurementInventory({materialDensity:af,results}),null);
  for(const results of [enclosed(10),enclosed(10,{status:'estimate',method:'reconstructed-estimate'})]) assert.equal(estimateMeasurementInventory({materialDensity:af,results}).volumeBasis,'enclosed_object');
  assert.equal(estimateMeasurementInventory({materialDensity:af,results:{volumeM3:10,status:'cancelled'}}),null);
});

test('enclosed inventory requires the actual completed or explicitly estimated producer contract', () => {
  for(const extra of [{status:undefined},{status:'running'},{status:'queued'},{status:'unknown'},{method:undefined},{method:'surface-cut-fill'},{method:'reconstructed-estimate',status:'complete'},{method:'closed-mesh',status:'estimate'}]) {
    const record={materialDensity:af,results:enclosed(10,extra)};
    assert.equal(estimateMeasurementInventory(record),null);
    assert.match(measurementInventoryUnavailableReason(record),/closed-mesh calculation|current material volume/);
  }
  for(const checks of [undefined,null,{},...Object.keys(enclosureChecks).flatMap(key=>[{...enclosureChecks,[key]:undefined},{...enclosureChecks,[key]:!enclosureChecks[key]},{...enclosureChecks,[key]:String(enclosureChecks[key])}])]) {
    const record={materialDensity:af,results:enclosed(10,{checks})};
    assert.equal(estimateMeasurementInventory(record),null);
    assert.match(measurementInventoryUnavailableReason(record),/validated enclosure/);
  }
  assert.ok(estimateMeasurementInventory({materialDensity:af,results:enclosed(10,{verified:false})}),'geometry checks do not attest survey accuracy');
});

test('enclosed and reconstructed inventory retain explicit geometry caveats and source warnings', () => {
  const warnings=['All reconstructed faces are inferred.','Nearby source samples do not prove accuracy.'];
  const estimate=estimateMeasurementInventory({materialDensity:af,results:enclosed(10,{method:'reconstructed-estimate',status:'estimate',warnings})});
  assert.equal(estimate.volumeMethod,'reconstructed-estimate');
  assert.equal(estimate.volumeStatus,'estimate');
  assert.deepEqual(estimate.volumeWarnings,warnings);
  assert.match(estimate.estimateNotice,/inferred geometry.*unseen underside/);
  assert.match(estimateMeasurementInventory({materialDensity:af,results:enclosed(10)}).estimateNotice,/not guaranteed physical-object or survey accuracy/);
});
