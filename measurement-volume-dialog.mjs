import {measurementValue} from './measurement-document.mjs';
import {mountMeasurementRegionPreview} from './measurement-region-preview.mjs';
import {buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent} from './measurement-cross-section.mjs';
import './measurement-volume-dialog.css';

// Invokes the existing authorized calculation path, never server processing.
// A sampled corridor is not a native-resolution elevation transect.
export function openSurfaceDialog({record,units,calculate,save,onClose=()=>{},autoCalculate=false}){
  const unit={imperial:['ft',0.3048],feet:['ft',0.3048],yards:['yd',0.9144],metric:['m',1],centimeters:['cm',0.01]}[units]||['ft',0.3048];
  const dialog=document.createElement('dialog');dialog.className='measurement-volume-dialog surface-inspector';
  dialog.innerHTML=`<header class="surface-heading"><div><p class="surface-eyebrow">Measurement inspector</p><h2>Surface cut / fill</h2><p data-name></p></div><button data-close aria-label="Close surface inspector">Close</button></header>
  <p class="surface-description">Explore the selected region above and below a reference base. This measures space between surfaces—not solid material inside a car, roof, or hollow object.</p>
  <details class="surface-settings" open><summary>Surface &amp; reference base</summary><div class="surface-settings-grid">
  <label>Elevation surface<select name="source"><option value="auto">Current surface / DSM</option><option value="dsm">DSM · objects and ground</option><option value="dtm">DTM · ground</option></select></label>
  <label>Reference base<select name="reference"><option value="boundary-triangulated">Triangulated boundary</option><option value="fitted-plane">Fitted sloping plane</option><option value="lowest-boundary">Lowest boundary</option><option value="highest-boundary">Highest boundary</option><option value="average-boundary">Average boundary</option><option value="custom">Custom horizontal elevation</option></select></label>
  <label data-custom hidden>Custom elevation (${unit[0]})<input name="elevation" type="number" step="any" value="0"></label><label>Base offset (${unit[0]})<input name="offset" type="number" step="any" value="0"></label></div>
  <label class="surface-confirm"><input name="metres" type="checkbox"><span>If vertical-unit metadata is absent, I confirm source elevations are in meters.</span></label>
  <p class="hint">Boundary points define a sloping base. Choose a custom elevation only when that height is known. Confirm meters only if you have verified the source vertical units. A DTM may remove the pile itself.</p></details>
  <div class="surface-action-bar"><button data-calculate>Calculate / update</button><span class="hint">Native surface cells · same selected boundary</span></div><p data-status role="status" data-state="idle">Choose a surface and base, then calculate. No volume has been calculated yet.</p>
  <div data-results class="surface-results" hidden><div class="surface-result"><span>Above base · cut</span><strong data-result="cut">—</strong></div><div class="surface-result"><span>Below base · fill</span><strong data-result="fill">—</strong></div><div class="surface-result"><span>Net volume</span><strong data-result="net">—</strong></div><div class="surface-result"><span>Source coverage</span><strong data-result="coverage">—</strong></div></div>
  <p data-preview-empty>The isolated surface and reference-base preview will appear after a successful calculation.</p><div data-preview-content hidden>
  <section class="surface-section"><div class="surface-section-header"><h3>Sampled cross-section preview</h3><p>A narrow corridor through the selected region. Hover or focus the chart and use arrow keys to inspect real retained samples.</p></div>
  <div class="section-controls"><label>Direction <output data-angle>0°</output><input name="azimuth" type="range" min="0" max="360" value="0" aria-label="Section direction in degrees"></label><label>Position <output data-offset></output><input name="sectionOffset" type="range" min="-100" max="100" value="0" aria-label="Section corridor position"></label><label>Corridor width <output data-width></output><input name="sectionWidth" type="range" min="1" max="100" value="10" aria-label="Section corridor width"></label></div>
  <div class="section-charts"><canvas data-section-plan width="300" height="300" aria-label="Selected region from above with section corridor and inspected sample"></canvas><canvas data-section-chart width="850" height="300" tabindex="0" aria-label="Sampled section. Left and right arrow keys inspect samples; Home and End select the first and last sample."></canvas></div>
  <div class="section-readout" data-readout role="status">Hover the chart to inspect a sample.</div><p class="section-provenance" data-provenance></p></section>
  <details class="region-disclosure"><summary>Explore the isolated region in 3D</summary><div data-region-preview></div></details></div>`;
  dialog.querySelector('[data-name]').textContent=record.name;
  let abort=null,preview=null,regionPreview=null,section=null,selected=null,chartBounds=null,retired=false,closed=false;
  const status=dialog.querySelector('[data-status]'),canvas=dialog.querySelector('[data-section-chart]'),plan=dialog.querySelector('[data-section-plan]');
  const field=name=>dialog.querySelector(`[name=${name}]`),value=name=>Number(field(name).value),format=v=>measurementValue(v,1,units);
  function plot(){
    const ctx=canvas.getContext('2d'),pc=plan.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);pc.clearRect(0,0,plan.width,plan.height);if(!section)return;
    const span=section.extent[1]-section.extent[0],crossSpan=section.crossExtent[1]-section.crossExtent[0];
    const px=p=>20+p.distance/Math.max(span,1e-9)*(plan.width-40),py=v=>plan.height-30-(v-section.crossExtent[0])/Math.max(crossSpan,1e-9)*(plan.height-60);
    pc.fillStyle='#687b91';for(const p of section.projected)pc.fillRect(px(p)-1,py(p.cross)-1,2,2);
    pc.fillStyle='#f3752328';pc.fillRect(20,py(section.offset+section.width/2),plan.width-40,Math.max(1,py(section.offset-section.width/2)-py(section.offset+section.width/2)));
    pc.strokeStyle='#f37523';pc.setLineDash([5,4]);pc.beginPath();pc.moveTo(20,py(section.offset));pc.lineTo(plan.width-20,py(section.offset));pc.stroke();pc.setLineDash([]);pc.fillStyle='#bac9d8';pc.font='12px system-ui';pc.fillText('Region · plan view',15,18);
    let bottom=Infinity,top=-Infinity;for(const p of section.points){bottom=Math.min(bottom,p.elevation,p.base);top=Math.max(top,p.elevation,p.base);}
    if(!section.points.length){ctx.fillStyle='#aebccc';ctx.font='15px system-ui';ctx.fillText('No retained samples in this corridor.',55,135);ctx.font='12px system-ui';ctx.fillText('Move or widen the corridor. Missing data is not zero.',55,160);chartBounds=null;return;}
    if(top-bottom<1e-6){bottom-=.5;top+=.5;}const pad=(top-bottom)*.08;bottom-=pad;top+=pad;
    const sx=v=>64+v/Math.max(span,1e-9)*(canvas.width-90),sy=v=>canvas.height-42-(v-bottom)/(top-bottom)*(canvas.height-68);
    chartBounds={sx,sy,span,bottom,top,left:64,right:canvas.width-26};ctx.font='11px system-ui';
    for(let i=0;i<=4;i++){const y=bottom+(top-bottom)*i/4,yy=sy(y);ctx.strokeStyle='#273240';ctx.beginPath();ctx.moveTo(64,yy);ctx.lineTo(canvas.width-26,yy);ctx.stroke();ctx.fillStyle='#aebccc';ctx.fillText((y/unit[1]).toLocaleString(undefined,{maximumFractionDigits:1}),5,yy+4);const x=span*i/4;ctx.fillText((x/unit[1]).toLocaleString(undefined,{maximumFractionDigits:1}),sx(x)-8,canvas.height-23);}
    ctx.fillStyle='#bdcbdc';ctx.fillText(`Elevation (${unit[0]})`,8,14);ctx.fillText(`Distance along corridor (${unit[0]})`,canvas.width/2-90,canvas.height-5);
    for(const p of section.points){ctx.fillStyle=p.difference>=0?'#ff963e':'#5cccf7';ctx.fillRect(sx(p.distance)-1.5,sy(p.elevation)-1.5,3,3);ctx.fillStyle='#bcc6d2';ctx.fillRect(sx(p.distance)-1,sy(p.base)-1,2,2);}
    if(selected){const x=sx(selected.distance),y=sy(selected.elevation);ctx.strokeStyle='#ffb47b';ctx.beginPath();ctx.moveTo(x,23);ctx.lineTo(x,canvas.height-42);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();pc.fillStyle='#fff';pc.beginPath();pc.arc(px(selected),py(selected.cross),5,0,Math.PI*2);pc.fill();}
  }
  function inspect(point){if(point===selected)return;selected=point;dialog.querySelector('[data-readout]').textContent=point?`Distance ${format(point.distance)} · Surface ${format(point.elevation)} · Base ${format(point.base)} · Δ ${format(point.difference)} · X ${point.x.toFixed(3)}, Y ${point.y.toFixed(3)} (source coordinates, m)`:'No nearby retained sample. Move along the chart or widen the corridor.';plot();}
  function rebuild({initial=false}={}){
    if(!preview?.samples?.length)return;const azimuth=value('azimuth'),all=buildSampledCrossSection(preview.samples,{azimuth,width:1});
    if(initial){field('sectionOffset').step='any';field('sectionOffset').value=String(initialSectionOffsetPercent(all));}
    const crossSpan=Math.max(all.crossExtent[1]-all.crossExtent[0],.01),offset=(all.crossExtent[0]+all.crossExtent[1])/2+value('sectionOffset')/100*crossSpan/2,width=crossSpan*value('sectionWidth')/100;
    section=buildSampledCrossSection(preview.samples,{azimuth,offset,width});selected=null;dialog.querySelector('[data-angle]').textContent=`${azimuth}°`;dialog.querySelector('[data-offset]').textContent=format(offset);dialog.querySelector('[data-width]').textContent=format(width);
    dialog.querySelector('[data-provenance]').textContent=`${section.points.length.toLocaleString()} of ${preview.samples.length.toLocaleString()} reduced samples inside the corridor. Orange: above base · Blue: below base · Gray: reference. Points are not joined: spaces may contain unsampled cells or NoData. This preview does not change the native-cell volume or establish a continuous terrain profile.`;
    dialog.querySelector('[data-readout]').textContent=section.points.length?'Hover the chart or use arrow keys to inspect a retained sample.':'No retained samples here. Adjust position or width; absence is not a measured zero.';plot();
  }
  for(const name of ['azimuth','sectionOffset','sectionWidth'])field(name).oninput=rebuild;
  canvas.onpointermove=event=>{if(!chartBounds)return;const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/Math.max(rect.width,1),y=(event.clientY-rect.top)*canvas.height/Math.max(rect.height,1),distance=(x-chartBounds.left)/(chartBounds.right-chartBounds.left)*chartBounds.span,elevation=chartBounds.bottom+(canvas.height-42-y)/(canvas.height-68)*(chartBounds.top-chartBounds.bottom);inspect(nearestSectionSample(section,distance,{tolerance:Math.max(chartBounds.span*12/(chartBounds.right-chartBounds.left),1e-9),elevation,verticalTolerance:(chartBounds.top-chartBounds.bottom)*14/(canvas.height-68)}));};
  canvas.onpointerleave=()=>inspect(null);
  canvas.onkeydown=event=>{if(!section?.points.length||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let index=selected?section.points.indexOf(selected):-1;if(event.key==='Home')index=0;else if(event.key==='End')index=section.points.length-1;else index=Math.max(0,Math.min(section.points.length-1,index+(event.key==='ArrowRight'?1:-1)));inspect(section.points[index]);};
  function invalidateSettings(){
    abort?.abort();preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;
    dialog.removeAttribute('aria-busy');dialog.removeAttribute('data-calculated');dialog.querySelector('[data-calculate]').disabled=false;dialog.querySelector('[data-results]').hidden=true;dialog.querySelector('[data-preview-content]').hidden=true;dialog.querySelector('[data-preview-empty]').hidden=false;
    dialog.querySelector('[data-preview-empty]').textContent='Settings changed. Calculate again to show a matching result and preview.';status.dataset.state='idle';status.textContent='Settings changed. The previously saved volume is unchanged; calculate to update it.';
  }
  field('reference').onchange=()=>{dialog.querySelector('[data-custom]').hidden=field('reference').value!=='custom';invalidateSettings();};
  for(const name of ['source','metres'])field(name).onchange=invalidateSettings;
  for(const name of ['offset','elevation'])field(name).oninput=invalidateSettings;
  dialog.querySelector('.region-disclosure').ontoggle=()=>{if(!retired&&dialog.querySelector('.region-disclosure').open&&preview&&!regionPreview)regionPreview=mountMeasurementRegionPreview(dialog.querySelector('[data-region-preview]'),{preview,units});};
  dialog.querySelector('[data-calculate]').onclick=async()=>{
    if(retired)return;
    abort?.abort();abort=new AbortController();const mine=abort;status.textContent='Checking source units and calculating the native-resolution surface…';status.dataset.state='loading';dialog.setAttribute('aria-busy','true');dialog.querySelector('[data-calculate]').disabled=true;
    preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;dialog.removeAttribute('data-calculated');dialog.querySelector('[data-results]').hidden=true;dialog.querySelector('[data-preview-content]').hidden=true;dialog.querySelector('[data-preview-empty]').hidden=false;dialog.querySelector('[data-preview-empty]').textContent='Calculating. The preview will appear only when a valid result is available.';
    const reference={type:field('reference').value,offsetM:value('offset')*unit[1]};if(reference.type==='custom')reference.elevationM=value('elevation')*unit[1];
    try{
      if(!String(field('offset').value).trim()||!Number.isFinite(reference.offsetM)||(reference.type==='custom'&&(!String(field('elevation').value).trim()||!Number.isFinite(reference.elevationM))))throw new Error('Enter a finite reference elevation and base offset.');
      const result=await calculate(record,{signal:mine.signal,reference,sourceKind:field('source').value,confirmMeters:field('metres').checked});if(mine.signal.aborted)return;
      if(result.preview?.samples?.length)buildSampledCrossSection(result.preview.samples,{width:1});
      const{preview:nextPreview,...persisted}=result;await save({...record,results:persisted});if(mine.signal.aborted)return;preview=nextPreview;
      status.dataset.state='success';status.textContent=`${result.status}: cut ${measurementValue(result.cutM3,3,units)}; fill ${measurementValue(result.fillM3,3,units)}; net ${measurementValue(result.netM3,3,units)}. Coverage ${(result.coverage*100).toFixed(3)}%. ${(result.warnings||[]).join(' ')}`;
      for(const [name,key] of [['cut','cutM3'],['fill','fillM3'],['net','netM3']])dialog.querySelector(`[data-result=${name}]`).textContent=measurementValue(result[key],3,units);dialog.querySelector('[data-result=coverage]').textContent=`${(result.coverage*100).toFixed(3)}%`;dialog.querySelector('[data-results]').hidden=false;
      dialog.querySelector('[data-preview-content]').hidden=!preview?.samples?.length;dialog.querySelector('[data-preview-empty]').hidden=!!preview?.samples?.length;dialog.querySelector('[data-preview-empty]').textContent='Calculation complete; no preview samples are available for this region.';
      if(preview?.samples?.length){rebuild({initial:true});if(dialog.querySelector('.region-disclosure').open)regionPreview=mountMeasurementRegionPreview(dialog.querySelector('[data-region-preview]'),{preview,units});}dialog.querySelector('.surface-settings').open=false;dialog.setAttribute('data-calculated','true');
    }catch(error){if(!mine.signal.aborted){status.dataset.state='error';status.textContent=`No new volume was saved. ${error.message}`;dialog.querySelector('[data-preview-empty]').textContent='Preview unavailable. Resolve the source or calculation issue above and try again.';dialog.querySelector('.surface-settings').open=true;}}
    finally{if(!mine.signal.aborted){dialog.removeAttribute('aria-busy');dialog.querySelector('[data-calculate]').disabled=false;}}
  };
  function retire(){if(retired)return;retired=true;abort?.abort();preview=null;section=null;selected=null;chartBounds=null;regionPreview?.dispose();regionPreview=null;}
  function close(){retire();dialog.close();}
  dialog.querySelector('[data-close]').onclick=close;
  // Native close events are queued. Retire synchronously before their dispatch
  // so a result settling in the intervening microtask cannot save private data.
  dialog.oncancel=()=>retire();
  dialog.onclose=()=>{retire();if(closed)return;closed=true;dialog.remove();onClose();};document.body.append(dialog);dialog.showModal();
  // Never autocheck units or guess a reference height. Missing metadata reopens settings.
  if(autoCalculate)dialog.querySelector('[data-calculate]').onclick();
  return {close};
}
