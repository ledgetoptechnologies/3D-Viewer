import {measurementValue} from './measurement-document.mjs';
import {mountMeasurementRegionPreview} from './measurement-region-preview.mjs';
// This local dialog never starts server processing. Preview samples come from
// the same elevation surface and reference used for integration.
export function openSurfaceDialog({record,units,calculate,save,onClose=()=>{}}){
  const unit={imperial:['ft',0.3048],feet:['ft',0.3048],yards:['yd',0.9144],metric:['m',1],centimeters:['cm',0.01]}[units]||['ft',0.3048];
  const dialog=document.createElement('dialog');dialog.className='measurement-volume-dialog';
  dialog.innerHTML=`<h2>Surface cut / fill</h2><p data-name></p><p>This measures space between the surface and reference base—not the solid material inside a car, roof, or hollow object.</p>
  <label>Surface <select name="source"><option value="auto">Current surface / DSM</option><option value="dsm">DSM (objects and ground)</option><option value="dtm">DTM (ground)</option></select></label>
  <label>Base <select name="reference"><option value="boundary-triangulated">Triangulated boundary</option><option value="fitted-plane">Fitted sloping plane</option><option value="lowest-boundary">Lowest boundary</option><option value="highest-boundary">Highest boundary</option><option value="average-boundary">Average boundary</option><option value="custom">Custom horizontal elevation</option></select></label>
  <label data-custom hidden>Custom elevation (${unit[0]}) <input name="elevation" type="number" step="any" value="0"></label><label>Base offset (${unit[0]}) <input name="offset" type="number" step="any" value="0"></label>
  <label><input name="metres" type="checkbox"> If vertical-unit metadata is absent, I confirm source elevations are in meters.</label>
  <div class="measurement-actions"><button data-calculate>Calculate / update</button><button data-close>Close</button></div><p data-status role="status"></p>
  <div data-region-preview></div><label>Side-view azimuth <input name="azimuth" type="range" min="0" max="360" value="0"></label><canvas width="850" height="380" aria-label="Isolated region and base preview"></canvas><p>Orange: above base · Blue: below base · Gray: reference. Reduced samples are for preview only; calculation uses native cells.</p>`;
  dialog.querySelector('[data-name]').textContent=record.name;
  let abort=null,preview=null,regionPreview=null;
  const status=dialog.querySelector('[data-status]'),canvas=dialog.querySelector('canvas');
  function draw(){
    const ctx=canvas.getContext('2d');ctx.fillStyle='#111820';ctx.fillRect(0,0,canvas.width,canvas.height);if(!preview?.samples?.length)return;
    const {samples}=preview,angle=Number(dialog.querySelector('[name=azimuth]').value)*Math.PI/180;
    const center=[0,1].map(i=>samples.reduce((s,p)=>s+p[i]/samples.length,0));
    const x=p=>(p[0]-center[0])*Math.cos(angle)+(p[1]-center[1])*Math.sin(angle);
    const extent=samples.map(x),lo=Math.min(...extent),hi=Math.max(...extent),bottom=Math.min(...samples.flatMap(p=>[p[2],p[3]])),top=Math.max(...samples.flatMap(p=>[p[2],p[3]]));
    const sx=v=>55+(v-lo)/Math.max(hi-lo,1e-9)*740,sy=v=>330-(v-bottom)/Math.max(top-bottom,1e-9)*275;
    for(const p of samples){const px=sx(x(p));ctx.strokeStyle=p[2]>=p[3]?'#f17625':'#38b7ea';ctx.globalAlpha=.35;ctx.beginPath();ctx.moveTo(px,sy(p[3]));ctx.lineTo(px,sy(p[2]));ctx.stroke();ctx.globalAlpha=1;ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(px-1,sy(p[2])-1,3,3);ctx.fillStyle='#c7ccd2';ctx.fillRect(px,sy(p[3]),2,2);}
    ctx.fillStyle='white';ctx.font='13px sans-serif';ctx.fillText(`Top ${measurementValue(top,1,units)}`,15,20);ctx.fillText(`Minimum ${measurementValue(bottom,1,units)}`,15,365);ctx.fillText(`Width ${measurementValue(hi-lo,1,units)}`,430,365);
  }
  dialog.querySelector('[name=azimuth]').oninput=draw;
  dialog.querySelector('[name=reference]').onchange=()=>{dialog.querySelector('[data-custom]').hidden=dialog.querySelector('[name=reference]').value!=='custom';};
  dialog.querySelector('[data-calculate]').onclick=async()=>{
    abort?.abort();abort=new AbortController();const mine=abort;status.textContent='Calculating native-resolution surface…';
    const reference={type:dialog.querySelector('[name=reference]').value,offsetM:Number(dialog.querySelector('[name=offset]').value)*unit[1]};
    if(reference.type==='custom')reference.elevationM=Number(dialog.querySelector('[name=elevation]').value)*unit[1];
    try{const result=await calculate(record,{signal:mine.signal,reference,sourceKind:dialog.querySelector('[name=source]').value,confirmMeters:dialog.querySelector('[name=metres]').checked});if(mine.signal.aborted)return;preview=result.preview;const{preview:discard,...persisted}=result;await save({...record,results:persisted});if(mine.signal.aborted)return;status.textContent=`${result.status}: cut ${measurementValue(result.cutM3,3,units)}; fill ${measurementValue(result.fillM3,3,units)}; net ${measurementValue(result.netM3,3,units)}. Coverage ${(result.coverage*100).toFixed(3)}%. ${(result.warnings||[]).join(' ')}`;if(regionPreview)regionPreview.update(preview,{displayUnits:units});else regionPreview=mountMeasurementRegionPreview(dialog.querySelector('[data-region-preview]'),{preview,units});draw();}catch(error){if(!mine.signal.aborted)status.textContent=error.message;}
  };
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>{abort?.abort();regionPreview?.dispose();dialog.remove();onClose();};document.body.append(dialog);dialog.showModal();draw();return {close:()=>dialog.close()};
}
