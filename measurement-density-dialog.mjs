import {normalizeMeasurementDensity, estimateMeasurementInventory, measurementInventoryUnavailableReason} from './measurement-density.mjs';
import {measurementValue} from './measurement-document.mjs';

const decimal = new Intl.NumberFormat('en-US', {minimumFractionDigits:3, maximumFractionDigits:3});
export function measurementMassSummary(record, units='imperial') {
  try {
    const estimate=estimateMeasurementInventory(record);
    if(!estimate)return record.materialDensity?measurementInventoryUnavailableReason(record):'';
    const metric=['metric','centimeters'].includes(units);
    const quantity=mass=>`${decimal.format(metric?mass.metricTonnes:mass.usShortTons)} ${metric?'metric tonnes':'US short tons'}`;
    return [estimate.asFed?`Estimated as-fed: ${quantity(estimate.asFed)}`:'',estimate.dryMatter?`Estimated dry matter: ${quantity(estimate.dryMatter)}`:''].filter(Boolean).join(' · ');
  } catch { return 'Weight unavailable: review density and current volume.'; }
}

/** Density evidence is independent of geometry and never changes the volume. */
export function openMeasurementDensityDialog({record,units='imperial',save,onClose=()=>{},temporary=false}) {
  const dialog=document.createElement('dialog');dialog.className='measurement-density-dialog';
  dialog.innerHTML=`<form><header><h2>Density & estimated weight</h2><p data-name></p></header>
    <p>Enter the bulk density measured for this pile. A drone measures volume; it does not measure density or weigh the silage.</p>
    <div class="density-fields"><label>Density<input name="density" type="number" min="0" step="any" required></label>
    <label>Density units<select name="unit"><option value="">Choose units</option><option value="lb/ft3">lb/ft³</option><option value="kg/m3">kg/m³</option></select></label>
    <label>Density basis<select name="basis"><option value="">Choose basis</option><option value="as_fed">As-fed · includes water</option><option value="dry_matter">Dry matter · excludes water</option></select></label>
    <label>Dry matter (%) · optional<input name="dm" type="number" min="0" max="100" step="any"></label>
    <label>Sampling date · optional<input name="sampledOn" type="date"></label>
    <label>Density source · optional<textarea name="sourceNote" maxlength="500" rows="2" placeholder="Lab, core samples, or client-provided estimate"></textarea></label></div>
    <p class="hint">Dry matter % converts between as-fed and dry-matter weight. Leave it blank when unknown. Packing targets and “achievable density” are not measured density.</p>
    <p data-mass role="status"></p><p class="hint" data-volume></p>
    <p class="hint">Weight is an estimate using current above-base cut volume (or enclosed-object volume). Density may vary across the pile; sampling and the selected base affect the result. Saving density during a calculation cancels that calculation; save it before starting a new one.</p>
    <p class="hint" data-storage></p><p data-error role="alert"></p>
    <div class="measurement-actions"><button type="submit">Save density</button><button type="button" data-remove>Remove density</button><button type="button" data-close>Cancel</button></div></form>`;
  const field=name=>dialog.querySelector(`[name="${name}"]`),current=record.materialDensity;
  dialog.querySelector('[data-name]').textContent=record.name;
  dialog.querySelector('[data-storage]').textContent=temporary?'Density and measurements stay in this tab only; refreshing or closing the page removes them.':'Density is saved with your personal measurement and included in its reports and exports.';
  for(const [name,value]of Object.entries({density:current?.value,unit:current?.unit,basis:current?.basis,dm:current?.dryMatterPercent,sampledOn:current?.sampledOn,sourceNote:current?.sourceNote}))field(name).value=value??'';
  dialog.querySelector('[data-remove]').hidden=!current;
  let retired=false,busy=false;
  const draft=()=>normalizeMeasurementDensity({value:Number(field('density').value),unit:field('unit').value,basis:field('basis').value,...(field('dm').value!==''?{dryMatterPercent:Number(field('dm').value)}:{}),sourceNote:field('sourceNote').value,sampledOn:field('sampledOn').value});
  const preview=()=>{
    const mass=dialog.querySelector('[data-mass]'),volume=dialog.querySelector('[data-volume]');
    try {
      const density=draft(),estimate=estimateMeasurementInventory({...record,materialDensity:density});
      mass.textContent=estimate?measurementMassSummary({...record,materialDensity:density},units):measurementInventoryUnavailableReason({...record,materialDensity:density});
      volume.textContent=estimate?`${estimate.volumeBasisLabel}: ${measurementValue(estimate.volumeM3,3,units)}. ${density.dryMatterPercent!==undefined?'The other weight basis is calculated from the entered dry matter %. ':''}${estimate.estimateNotice}`:'';
    } catch(error) { mass.textContent='Enter a positive density and choose its units and basis.';volume.textContent=''; }
  };
  const close=()=>{if(retired||busy)return;retired=true;dialog.close();dialog.remove();onClose();};
  const persist=async density=>{
    if(busy||retired)return;busy=true;
    for(const button of dialog.querySelectorAll('button'))button.disabled=true;
    dialog.querySelector('[data-error]').textContent='';
    try {await save(density);busy=false;close();}
    catch(error){if(!retired){dialog.querySelector('[data-error]').textContent=error.message;busy=false;for(const button of dialog.querySelectorAll('button'))button.disabled=false;}}
  };
  dialog.querySelector('form').onsubmit=event=>{event.preventDefault();try{void persist(draft());}catch(error){dialog.querySelector('[data-error]').textContent=error.message;}};
  dialog.querySelector('[data-remove]').onclick=()=>void persist(null);
  dialog.querySelector('[data-close]').onclick=close;
  dialog.oncancel=event=>{event.preventDefault();close();};
  dialog.onclose=()=>{if(!retired){retired=true;dialog.remove();onClose();}};
  dialog.querySelector('form').oninput=preview;
  document.body.append(dialog);dialog.showModal();preview();field('density').focus();
  return {close:()=>{busy=false;close();}};
}
