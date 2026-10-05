// Material mass is an estimate from measured volume and explicitly supplied density.
// As-fed and dry-matter quantities must never be treated as interchangeable.
export const KILOGRAMS_PER_POUND = 0.45359237;
export const CUBIC_METRES_PER_CUBIC_FOOT = 0.3048 ** 3;
export const POUNDS_PER_US_SHORT_TON = 2000;
export const CUBIC_FEET_PER_CUBIC_YARD = 27;

export function normalizeMeasurementDensity(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Density must be an object.');
  const {value, unit, basis, dryMatterPercent, sourceNote, sampledOn} = input;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Density must be a finite positive number.');
  if (!['lb/ft3', 'kg/m3'].includes(unit)) throw new Error('Choose density units: lb/ft3 or kg/m3.');
  if (!['as_fed', 'dry_matter'].includes(basis)) throw new Error('Choose an as-fed or dry-matter density basis.');
  const kgM3 = unit === 'kg/m3' ? value : value * KILOGRAMS_PER_POUND / CUBIC_METRES_PER_CUBIC_FOOT;
  const lbFt3 = unit === 'lb/ft3' ? value : value * CUBIC_METRES_PER_CUBIC_FOOT / KILOGRAMS_PER_POUND;
  if (![kgM3, lbFt3].every(Number.isFinite)) throw new Error('Density exceeds the supported numeric range.');
  const density = {value, unit, basis};
  if (dryMatterPercent !== undefined && dryMatterPercent !== null) {
    if (!Number.isFinite(dryMatterPercent) || dryMatterPercent <= 0 || dryMatterPercent > 100) throw new Error('Dry matter must be greater than 0 and at most 100 percent.');
    density.dryMatterPercent = dryMatterPercent;
  }
  if (sourceNote !== undefined && sourceNote !== null) {
    if (typeof sourceNote !== 'string' || sourceNote.length > 500) throw new Error('Density source note must be text of at most 500 characters.');
    const note = sourceNote.trim();
    if (note) density.sourceNote = note;
  }
  if (sampledOn !== undefined && sampledOn !== null && sampledOn !== '') {
    if (typeof sampledOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sampledOn)) throw new Error('Density sampling date must use YYYY-MM-DD.');
    const date = new Date(`${sampledOn}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== sampledOn) throw new Error('Density sampling date must be a valid calendar date.');
    density.sampledOn = sampledOn;
  }
  return density;
}

const massQuantities = (kilograms, basis) => {
  const pounds = kilograms / KILOGRAMS_PER_POUND;
  const usShortTons = pounds / POUNDS_PER_US_SHORT_TON;
  const metricTonnes = kilograms / 1000;
  if (![kilograms, pounds, usShortTons, metricTonnes].every(Number.isFinite)) throw new Error('Density and volume exceed the supported numeric range.');
  return {basis, kilograms, pounds, usShortTons, metricTonnes};
};

export function estimateMeasurementMass(volumeM3, input) {
  const density = normalizeMeasurementDensity(input);
  if (!density) return null;
  if (!Number.isFinite(volumeM3) || volumeM3 < 0) throw new Error('Material volume must be a finite nonnegative number.');
  const densityKgM3 = density.unit === 'kg/m3' ? density.value : density.value * KILOGRAMS_PER_POUND / CUBIC_METRES_PER_CUBIC_FOOT;
  if (!Number.isFinite(densityKgM3)) throw new Error('Density exceeds the supported numeric range.');
  const massKg = volumeM3 * densityKgM3;
  const fraction = density.dryMatterPercent === undefined ? null : density.dryMatterPercent / 100;
  const asFedKg = density.basis === 'as_fed' ? massKg : fraction === null ? null : massKg / fraction;
  const dryMatterKg = density.basis === 'dry_matter' ? massKg : fraction === null ? null : massKg * fraction;
  return {
    volumeM3, density, densityKgM3,
    ...(fraction === null ? {} : {derivedBasis:density.basis === 'as_fed' ? 'dry_matter' : 'as_fed'}),
    asFed: asFedKg === null ? null : massQuantities(asFedKg, 'as_fed'),
    dryMatter: dryMatterKg === null ? null : massQuantities(dryMatterKg, 'dry_matter'),
  };
}

export const MATERIAL_MASS_ESTIMATE_NOTICE = 'Estimated inventory from entered density and calculated volume; material was not weighed. Accuracy depends on representative density samples and volume/base-surface accuracy.';

/** Missing surface evidence must not silently establish whole-pile inventory. */
export function measurementInventoryUnavailableReason(record) {
  if (!record?.materialDensity) return 'Enter density with explicit units and basis.';
  try { normalizeMeasurementDensity(record.materialDensity); }
  catch { return 'Unavailable: review the entered density, units and basis.'; }
  const result = record.results;
  if (!result || result.volumeInvalidated || ['geometry-only', 'historical', 'incomplete', 'failed', 'error', 'pending', 'calculating', 'cancelled'].includes(result.status)) return 'Unavailable: calculate a current material volume before estimating inventory.';
  if (Object.hasOwn(result, 'cutM3')) {
    // Native raster and original-point calculations use complete; the saved
    // surface client also supports calculated. No other state establishes a
    // completed surface quantity. Enclosed objects have separate evidence.
    if (!['complete', 'calculated'].includes(result.status)) return 'Unavailable: a completed surface calculation is required for whole-pile inventory.';
    if (!Number.isFinite(result.coverage) || result.coverage !== 1) return 'Unavailable: confirmed 100% numeric surface coverage is required for whole-pile inventory.';
    if (!Number.isFinite(result.cutM3) || result.cutM3 < 0) return 'Unavailable: above-base cut volume must be a finite nonnegative quantity.';
  } else {
    if (!Number.isFinite(result.volumeM3) || result.volumeM3 < 0) return 'Calculate a current material volume before estimating inventory.';
    const supported = result.method === 'closed-mesh' && result.status === 'complete'
      || result.method === 'reconstructed-estimate' && result.status === 'estimate';
    if (!supported) return 'Unavailable: a completed closed-mesh calculation or explicit reconstructed estimate is required for enclosed-object inventory.';
    const checks = result.checks;
    if (!checks || !['closed', 'edgeManifold', 'vertexManifold', 'orientationConsistent'].every(key => checks[key] === true) || checks.selfIntersections !== false) return 'Unavailable: validated enclosure, manifold, orientation and intersection checks are required for enclosed-object inventory.';
    if (typeof result.coverage === 'number' && (!Number.isFinite(result.coverage) || result.coverage !== 1)) return 'Unavailable: incomplete coverage cannot establish whole-object inventory.';
  }
  try { estimateMeasurementMass(Object.hasOwn(result, 'cutM3') ? result.cutM3 : result.volumeM3, record.materialDensity); }
  catch { return 'Unavailable: density and volume exceed the supported numeric range.'; }
  return null;
}

/** Only present calculation quantities can describe current material inventory. */
export function estimateMeasurementInventory(record) {
  if (measurementInventoryUnavailableReason(record)) return null;
  const result = record.results;
  const validVolume = value => Number.isFinite(value) && value >= 0;
  const key = validVolume(result.cutM3) ? 'cutM3' : validVolume(result.volumeM3) ? 'volumeM3' : null;
  if (!key) return null;
  let estimate;
  try { estimate = estimateMeasurementMass(result[key], record.materialDensity); }
  catch { return null; }
  return {
    ...estimate,
    volumeBasis: key === 'cutM3' ? 'cut_above_base' : 'enclosed_object',
    volumeBasisLabel: key === 'cutM3' ? 'Above-base (cut) volume' : 'Enclosed-object volume',
    estimateNotice: MATERIAL_MASS_ESTIMATE_NOTICE + (key === 'volumeM3'
      ? result.method === 'reconstructed-estimate'
        ? ' Reconstructed enclosure is inferred geometry; it may bridge holes or infer an unseen underside and is not validated observed-object volume.'
        : ' Enclosed volume describes observed closed geometry, not guaranteed physical-object or survey accuracy.'
      : ''),
    ...(key === 'volumeM3' ? {volumeMethod:result.method, volumeStatus:result.status, volumeWarnings:Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string') : []} : {}),
  };
}
