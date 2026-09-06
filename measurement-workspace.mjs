import { measurementCollection, measurementMetrics, measurementValue, validateMeasurementGeometry, exportMeasurements } from './measurement-document.mjs';
import { createMeasurementStore } from './measurement-store.mjs';
import './measurement-workspace.css';
import {openSurfaceDialog} from './measurement-volume-dialog.mjs';
import {openAdminCalculationDialog} from './measurement-admin-dialog.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = event => event.target?.closest?.('input,textarea,select,[contenteditable=true]');
const interactive = event => event.target?.closest?.('input,textarea,select,button,a,[contenteditable=true],.leaflet-control,[role=button]');
const savedUnits = {imperial:'imperial',feet:'ft',yards:'yd',metric:'m',centimeters:'cm'};
const restoredUnits = {imperial:'imperial','ft-in':'imperial',ft:'feet',yd:'yards',metric:'metric',m:'metric',cm:'centimeters'};

export function createMeasurementWorkspace({ panel, context, token, permitted, toolChanged, coordinateReference, toLonLat, calculateSurface, adminRequest, onAccessLost=()=>{} }) {
  let units='imperial',draft=null,selected=null,editing=false,cursor=null,bound=null,gesture=null,space=false,shift=false,lastSvg='',disposed=false,volumeAbort=null,ready=!token(),lastCollection=null;
  const selectedExports=new Set(),reportDialogs=new Set();
  const metricCache=new WeakMap();
  let adminAllowed=false,activeDialog=null,invalidated=false,viewGeneration=0,dialogGeneration=0;
  const store=createMeasurementStore({token,changed:renderPanel});
  const allowed=()=>permitted()&&!invalidated&&!store.isInvalidated?.();
  const message=document.createElement('p');message.className='measurement-message';message.setAttribute('role','status');
  const controls=document.createElement('div');controls.className='measurement-workspace';
  controls.innerHTML=`<label>Units <select data-m="units"><option value="imperial">Feet / inches</option><option value="feet">Decimal feet</option><option value="yards">Yards</option><option value="metric">Meters</option><option value="centimeters">Centimeters</option></select></label>
    <div class="measurement-actions"><button data-m="finish">Finish</button><button data-m="undo">Undo point</button><button data-m="edit">Edit selected</button><button data-m="focus">Focus selected</button></div>
    <p class="hint">Shift: navigate · Backspace: undo · Space-drag: move vertex · Enter / Esc / right-click: finish</p>
    <p class="hint">Measurements are private to you. Public-link changes reset on refresh. Display precision is not survey accuracy.</p>
    <div data-m-list></div><button data-m="reload">Reload saved measurements</button>
    <div class="measurement-actions"><select data-m="format" aria-label="Export format"><option value="csv">CSV summary</option><option value="json">JSON data</option><option value="dxf">DXF (meters)</option><option value="geojson">GeoJSON</option></select><button data-m="export">Export selected / visible</button></div>
    <div class="measurement-actions"><button data-m="screenshot">Save view PNG</button><button data-m="report">Print / PDF report</button></div>`;
  panel.append(controls,message);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('measurement-overlay');svg.setAttribute('aria-hidden','true');
  const densityNotice=document.createElement('p');densityNotice.className='hint';controls.append(densityNotice);
  function metrics(record){if(record===draft)return measurementMetrics(record);let value=metricCache.get(record);if(!value){value=measurementMetrics(record);metricCache.set(record,value);}return value;}
  function tell(text){message.textContent=text;}
  function records(){if(!allowed())return [];const family=measurementCollection(context()?.mode);return [...store.records.values()].filter(r=>r.collection===family);}
  function summary(record){const m=metrics(record);return record.kind==='distance'?measurementValue(m.lengthM,1,units):`${measurementValue(m.horizontalAreaM2,2,units)} horizontal · ${measurementValue(m.lengthM,1,units)} perimeter${m.planarAreaM2!==null&&record.collection!=='map'?` · ${measurementValue(m.planarAreaM2,2,units)} planar`:''}`;}
  function calculationSummary(record){
    const r=record.results;if(!r||r.status==='geometry-only')return 'Vertex geometry only; no surface or object volume calculated.';
    const quantity=Number.isFinite(r.volumeM3)?`${r.estimated||r.status==='estimate'||r.method==='reconstructed-estimate'?'Estimated ':''}Volume ${measurementValue(r.volumeM3,3,units)}`:`Cut ${measurementValue(r.cutM3,3,units)} · Fill ${measurementValue(r.fillM3,3,units)} · Net ${measurementValue(r.netM3,3,units)}`;
    return [quantity,`${r.method||'Calculation'} · ${r.status||'result'}`,r.reference?`Base: ${r.reference.type}; offset ${measurementValue(r.reference.offsetM||0,1,units)}${Number.isFinite(r.reference.elevationM)?`; elevation ${measurementValue(r.reference.elevationM,1,units)}`:''}`:'',Number.isFinite(r.coverage)?`Coverage ${(r.coverage*100).toFixed(3)}%`:'',...(r.warnings||[])].filter(Boolean).join('\n');
  }
  function renderPanel(){
    if(disposed)return;
    if(store.isInvalidated?.()&&!invalidated){invalidate('Personal measurements unavailable. Restore access and reload your measurements.');return;}
    const list=controls.querySelector('[data-m-list]');
    list.innerHTML=records().map(r=>`<article class="measurement-row ${selected===r.id?'selected':''}" data-record="${escape(r.id)}"><div><input type="checkbox" data-m="export-check" aria-label="Select ${escape(r.name)} for export" ${selectedExports.has(r.id)?'checked':''}><button data-m="select">${escape(r.name)}</button></div><small>${escape(summary(r))}</small><small>${escape(store.statuses.get(r.id)||'')}</small><div class="measurement-actions"><button data-m="visibility">${r.visible===false?'Show':'Hide'}</button><button data-m="rename">Rename</button><button data-m="delete">Delete</button>${r.kind==='polygon'?'<button data-m="volume">Surface cut/fill</button>':''}${r.kind==='polygon'&&adminAllowed?'<button data-m="admin-volume">Admin calculation</button>':''}</div>${Number.isFinite(r.results?.cutM3)?`<small>${escape(r.results.status||'Calculated')}: cut ${escape(measurementValue(r.results.cutM3,3,units))} · fill ${escape(measurementValue(r.results.fillM3,3,units))}</small>`:Number.isFinite(r.results?.volumeM3)?`<small>${escape(r.results.status||'Calculated')}: ${escape(measurementValue(r.results.volumeM3,3,units))}</small>`:''}</article>`).join('')||'<p class="hint">No measurements in this view group.</p>';
    controls.querySelector('[data-m="reload"]').hidden=!token();
  }
  function draftRecord(){return {...draft,vertices:draft.vertices.map(p=>p.slice())};}
  function disarm(){draft=null;editing=false;cursor=null;gesture=null;space=false;toolChanged('none');}
  function closeReports(){for(const dialog of [...reportDialogs])dialog.retire();}
  function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;closeReports();}
  function invalidate(reason='Personal measurements unavailable.'){
    if(invalidated)return;invalidated=true;viewGeneration++;ready=false;adminAllowed=false;selected=null;selectedExports.clear();disarm();closeDialogs();store.invalidate?.();svg.innerHTML='';lastSvg='';controls.hidden=true;tell(reason);onAccessLost();
  }
  async function finish(){
    if(!draft)return;
    if(draft.vertices.length<(draft.kind==='polygon'?3:2)){disarm();tell('Incomplete measurement cancelled.');return;}
    const record={...draftRecord(),displayPreferences:{...draft.displayPreferences,units:savedUnits[units]}};
    try{record.results={...measurementMetrics(record),status:'geometry-only',method:'vertex-geometry',...(record.collection==='map'?{elevationBasis:'not-sampled',warnings:['Map geometry is two-dimensional; stored Z=0 is a placeholder, not measured elevation. Surface calculations sample native elevations separately.']}:{} )};validateMeasurementGeometry(record);selected=record.id;disarm();await store.save(record);tell(store.persistent()?'Measurement saved privately.':'Temporary measurement — resets on refresh.');}
    catch(error){tell(error.message);}
  }
  function setTool(tool){
    if(!allowed())return;
    if(!ready){tell('Wait for your saved measurements to load.');return;}
    if(tool==='clear'){tell('Select an individual measurement and use Delete.');return;}
    if(tool==='none'){void finish();return;}
    if(draft){tell('Finish the current measurement before starting another.');return;}
    const family=measurementCollection(context()?.mode),kind=tool==='distance'?'distance':'polygon';
    const sourceMode=context()?.mode;
    draft={id:crypto.randomUUID(),name:`${kind==='distance'?'Distance':'Polygon'} ${records().length+1}`,kind,collection:family,vertices:[],coordinateReference:coordinateReference(),visible:true,source:{kind:sourceMode==='model'?'mesh':sourceMode==='cloud'?'pointCloud':sourceMode}};
    editing=false;toolChanged(tool==='volume'?'area':tool);tell('Click to place points. Hold Shift to navigate.');
  }
  function editRecord(record){if(!record)return;draft=structuredClone(record);editing=true;selected=record.id;cursor=null;toolChanged('edit');tell('Drag a vertex to adjust it. Shift navigates; Finish saves.');}
  function nearest(event){if(!draft)return -1;const rect=bound.element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;let best=-1,d=18;draft.vertices.forEach((p,i)=>{const q=bound.project(p);if(q){const n=Math.hypot(q[0]-x,q[1]-y);if(n<d){best=i;d=n;}}});return best;}
  function stop(event){event.preventDefault();event.stopImmediatePropagation();}
  function pointerDown(event){
    if(!allowed()||!draft||event.shiftKey||interactive(event))return;
    if(event.button!==0&&event.button!==2)return;
    gesture={x:event.clientX,y:event.clientY,button:event.button,index:(space||editing)?nearest(event):-1};
    if(event.button===0)bound.element.setPointerCapture?.(event.pointerId);
    stop(event);
  }
  function pointerMove(event){
    if(!allowed()||!draft||event.shiftKey||shift||interactive(event))return;
    if(event.buttons && !gesture)return;
    const point=bound.pick(event);
    if(point){if(gesture?.index>=0)draft.vertices[gesture.index]=point;else if(!editing)cursor=point;}
    if(gesture)stop(event);
  }
  function pointerUp(event){
    if(!allowed()){disarm();return;}
    if(!gesture)return;
    const g=gesture;gesture=null;stop(event);
    try{bound.element.releasePointerCapture?.(event.pointerId);}catch{}
    if(event.shiftKey||Math.hypot(event.clientX-g.x,event.clientY-g.y)>6||g.index>=0)return;
    if(g.button===2){void finish();return;}
    if(editing)return;
    if(draft.vertices.length>=2000){tell('Maximum 2000 vertices. Finish this measurement before adding another.');return;}
    const point=bound.pick(event);
    if(point && (!draft.vertices.length||Math.hypot(...point.map((v,i)=>v-draft.vertices.at(-1)[i]))>1e-8))draft.vertices.push(point);
    if(draft.kind==='distance'&&draft.vertices.length===2)void finish();
  }
  function keyDown(event){
    if(field(event))return;
    if(event.key==='Shift')shift=true;
    if(!draft)return;
    if(event.code==='Space'){space=true;stop(event);}
    else if(event.key==='Backspace'){draft.vertices.pop();cursor=null;stop(event);}
    else if(event.key==='Escape'||event.key==='Enter'){stop(event);void finish();}
  }
  function keyUp(event){if(event.code==='Space')space=false;if(event.key==='Shift')shift=false;}
  function blur(){gesture=null;space=false;shift=false;cursor=null;}
  const contextMenu=e=>{if(draft&&!e.shiftKey)stop(e);};
  function bind(next){
    if(bound?.element===next?.element){bound=next;return;}
    if(bound){for(const [event,fn]of handlers)bound.element.removeEventListener(event,fn,true);bound.element.ownerDocument.defaultView.removeEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.removeEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.removeEventListener('blur',blur);}
    svg.remove();bound=next;lastSvg='';
    if(!bound)return;
    bound.host.append(svg);
    for(const [event,fn]of handlers)bound.element.addEventListener(event,fn,true);
    bound.element.ownerDocument.defaultView.addEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.addEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.addEventListener('blur',blur);
  }
  const handlers=[['pointerdown',pointerDown],['pointermove',pointerMove],['pointerup',pointerUp],['pointercancel',blur],['contextmenu',contextMenu],['dblclick',e=>{if(draft)stop(e);}]];
  function draw(){
    if(disposed)return;
    bind(context());
    const collection=measurementCollection(bound?.mode);
    if(collection!==lastCollection){lastCollection=collection;selected=null;selectedExports.clear();renderPanel();}
    if(!permitted()){invalidate('Personal measurements are hidden until access is restored.');return;}
    if(!bound||!allowed()){if(!allowed()&&draft)disarm();svg.innerHTML='';lastSvg='';return;}
    const rect=bound.element.getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);
    const all=records().filter(r=>r.visible!==false&&r.id!==draft?.id).sort((a,b)=>Number(b.id===selected)-Number(a.id===selected));if(draft)all.unshift(draft);
    let markup='',displayVertices=0,labelCount=0,decluttered=false;
    for(const r of all){
      if(displayVertices+r.vertices.length>5000){decluttered=true;continue;}
      displayVertices+=r.vertices.length;
      const vertices=r.vertices.slice();if(r===draft&&cursor&&!editing)vertices.push(cursor);
      const positions=vertices.map(p=>bound.project(p));if(!positions.length||positions.some(p=>!p))continue;
      if(positions.every(p=>p[0]<0)||positions.every(p=>p[0]>rect.width)||positions.every(p=>p[1]<0)||positions.every(p=>p[1]>rect.height))continue;
      const points=positions.map(p=>`${p[0]},${p[1]}`).join(' '),closed=r.kind==='polygon'&&positions.length>=3;
      markup+=`<${closed?'polygon':'polyline'} points="${points}" fill="${closed?'#ee5007':'none'}" fill-opacity="0.12" stroke="${r.id===selected?'#fff':'#f8cb2e'}" stroke-width="2"/>`;
      for(let i=0;i<r.vertices.length;i++){const p=positions[i];markup+=`<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#ee5007" stroke="#fff" stroke-width="1"/>`;}
      const text=(x,y,value)=>{if(++labelCount>1000){decluttered=true;return '';}return `<text x="${x}" y="${y}" text-anchor="middle" fill="white" stroke="#121212" stroke-width="4" paint-order="stroke" font-size="12" font-family="sans-serif">${escape(value)}</text>`;};
      if(vertices.length>=2){const lengths=(r===draft?measurementMetrics({...r,vertices}):metrics(r)).edgeLengthsM;for(let i=0;i<lengths.length;i++){const a=positions[i],b=positions[(i+1)%positions.length];markup+=text((a[0]+b[0])/2,(a[1]+b[1])/2-7,measurementValue(lengths[i],1,units));}}
      if(r!==draft){const center=positions.reduce((s,p)=>[s[0]+p[0]/positions.length,s[1]+p[1]/positions.length],[0,0]);markup+=text(center[0],center[1]+15,r.name);if(closed)markup+=text(center[0],center[1]+30,measurementValue(measurementMetrics(r).horizontalAreaM2,2,units)+' horizontal');}
      if(r!==draft&&(Number.isFinite(r.results?.volumeM3)||Number.isFinite(r.results?.cutM3))){
        const center=positions.reduce((s,p)=>[s[0]+p[0]/positions.length,s[1]+p[1]/positions.length],[0,0]);
        const quantity=Number.isFinite(r.results.volumeM3)?`${r.results.estimated||r.results.status==='estimate'||r.results.method==='reconstructed-estimate'?'Estimated ':''}volume ${measurementValue(r.results.volumeM3,3,units)}`:`Cut ${measurementValue(r.results.cutM3,3,units)} · Fill ${measurementValue(r.results.fillM3,3,units)}`;
        markup+=text(center[0],center[1]+46,quantity);
      }
    }
    densityNotice.textContent=decluttered?'Display decluttered for responsiveness. Select a measurement to prioritize it, or hide others. Saved geometry and calculations are unchanged.':'';
    if(markup!==lastSvg){svg.innerHTML=markup;lastSvg=markup;}
  }
  const timer=setInterval(draw,33);
  function download(content,name,type){const url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function exportRecords(){const candidates=records();return selectedExports.size?candidates.filter(r=>selectedExports.has(r.id)):candidates.filter(r=>r.visible!==false);}
  async function screenshot(){
    draw();if(!bound||!allowed())throw new Error('View is not ready or access is unavailable.');
    const view=bound,generation=viewGeneration,displayUnits=units,crs=coordinateReference().crs,serialized=new XMLSerializer().serializeToString(svg);
    const assertCurrent=()=>{if(disposed||!allowed()||generation!==viewGeneration||view.element!==bound?.element||view.mode!==bound?.mode||displayUnits!==units)throw new Error('The view changed during capture. Capture the current view again.');};
    const canvas=await view.capture();assertCurrent();const ctx=canvas.getContext('2d');
    const image=new Image();const source=new Blob([serialized],{type:'image/svg+xml'});const url=URL.createObjectURL(source);
    try{image.src=url;await image.decode();assertCurrent();ctx.drawImage(image,0,0,canvas.width,canvas.height);}finally{URL.revokeObjectURL(url);}
    ctx.fillStyle='#101010';ctx.fillRect(0,canvas.height-28,canvas.width,28);ctx.fillStyle='white';ctx.font='12px sans-serif';ctx.fillText(`Measurements · ${displayUnits} · ${crs} · source accuracy not implied by display precision`,10,canvas.height-10);
    return canvas;
  }
  async function report(){
    const generation=viewGeneration,chosen=structuredClone(exportRecords()),canvas=await screenshot();
    if(disposed||!allowed()||generation!==viewGeneration)throw new Error('Access or view changed during report capture.');
    const dialog=document.createElement('dialog');dialog.className='measurement-report';
    dialog.innerHTML=`<div class="measurement-actions"><button data-print>Print / Save as PDF</button><button data-close>Close</button></div><h1>Measurement report</h1><p>${escape(coordinateReference().crs)} · ${escape(units)} · ${escape(new Date().toISOString())}</p><img alt="Measured view"><table><thead><tr><th>Name</th><th>Geometry</th><th>Calculation</th></tr></thead><tbody>${chosen.map(r=>`<tr><td>${escape(r.name)}</td><td>${escape(summary(r))}<br>Edges: ${escape(measurementMetrics(r).edgeLengthsM.map(v=>measurementValue(v,1,units)).join(' · '))}</td><td style="white-space:pre-line">${escape(calculationSummary(r))}</td></tr>`).join('')}</tbody></table><p>Display precision does not establish survey accuracy. Estimated geometry and missing coverage must be considered before using quantities. Coordinates and calculation provenance are available in the JSON export. Map-only geometry has no measured elevation until a surface calculation is performed.</p>`;
    dialog.retire=()=>{if(!reportDialogs.delete(dialog))return;dialog.querySelector('img').removeAttribute('src');dialog.innerHTML='';dialog.remove();};
    reportDialogs.add(dialog);dialog.querySelector('img').src=canvas.toDataURL('image/png');document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.retire();dialog.onclose=()=>dialog.retire();dialog.querySelector('[data-print]').onclick=()=>{if(disposed||!allowed()||generation!==viewGeneration){dialog.retire();return;}window.print();};
  }
  controls.addEventListener('change',event=>{if(event.target.dataset.m==='units'){units=event.target.value;const record=store.records.get(selected);if(record&&!draft)void store.save({...record,displayPreferences:{...record.displayPreferences,units:savedUnits[units]}}).catch(error=>tell(error.message));renderPanel();}if(event.target.dataset.m==='export-check'){const id=event.target.closest('[data-record]').dataset.record;event.target.checked?selectedExports.add(id):selectedExports.delete(id);}});
  controls.addEventListener('click',async event=>{
    if(!allowed()){tell('Access to these personal measurements is unavailable.');return;}
    const action=event.target.closest('[data-m]')?.dataset.m,id=event.target.closest('[data-record]')?.dataset.record,record=store.records.get(id);
    try{
      if(action==='finish')await finish();
      if(action==='undo'&&draft)draft.vertices.pop();
      if(action==='edit')editRecord(store.records.get(selected));
      if(action==='focus'){const chosen=store.records.get(selected);if(chosen)context()?.focus?.(chosen.vertices);else tell('Select a measurement name first.');}
      if(action==='select'){selected=id;if(restoredUnits[record.displayPreferences?.units]){units=restoredUnits[record.displayPreferences.units];controls.querySelector('[data-m="units"]').value=units;}renderPanel();}
      if(action==='reload'){const notice=await store.load();ready=true;tell(notice||'Saved measurements reloaded.');}
      if(action==='visibility')await store.save({...record,visible:record.visible===false});
      if(action==='delete'){await store.remove(id);selectedExports.delete(id);if(draft?.id===id)disarm();}
      if(action==='rename'){
        const row=event.target.closest('[data-record]'),input=document.createElement('input');input.value=record.name;input.maxLength=160;input.setAttribute('aria-label','Measurement name');event.target.replaceWith(input);input.focus();input.select();
        input.addEventListener('keydown',async e=>{if(e.key==='Escape')renderPanel();if(e.key==='Enter'&&input.value.trim()){try{await store.save({...record,name:input.value.trim()});}catch(error){tell(error.message);}}});
      }
      if(action==='export'){const format=controls.querySelector('[data-m="format"]').value;download(exportMeasurements(exportRecords(),format,{toLonLat,units}),`measurements.${format}`,format==='json'||format==='geojson'?'application/json':'text/plain');}
      if(action==='screenshot'){const generation=viewGeneration,displayUnits=units;const canvas=await screenshot();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(disposed||!allowed()||generation!==viewGeneration||displayUnits!==units)throw new Error('The view changed during capture. Capture the current view again.');if(!blob)throw new Error('View capture unavailable.');download(blob,'measured-view.png');}
      if(action==='report')await report();
      if(action==='volume'){
        let snapshot=structuredClone(record);
        closeDialogs();
        activeDialog=openSurfaceDialog({record,units,calculate:calculateSurface,save:async r=>{await store.attachResults(snapshot,r.results);snapshot=structuredClone(store.records.get(record.id));},onClose:()=>{activeDialog=null;}});
      }
      if(action==='admin-volume'&&adminAllowed){
        let snapshot=structuredClone(record);
        closeDialogs();const generation=viewGeneration,dialogId=dialogGeneration,isCurrent=()=>!disposed&&allowed()&&generation===viewGeneration&&dialogId===dialogGeneration;
        const opened=await openAdminCalculationDialog({record,units,request:adminRequest,isCurrent,onOpened:handle=>{if(isCurrent())activeDialog=handle;else handle.close();},onResult:async({calculation})=>{if(!isCurrent())throw new Error('Measurement access changed.');const {preview,...results}=calculation.result;await store.attachResults(snapshot,{...results,calculationJobId:calculation.id});snapshot=structuredClone(store.records.get(record.id));return snapshot;},onClose:()=>{if(dialogId===dialogGeneration)activeDialog=null;}});
        if(isCurrent())activeDialog=opened;else opened?.close();
      }
    }catch(error){tell(error.message);}
  });
  store.load().then(notice=>{ready=true;if(notice)tell(notice);}).catch(error=>{tell(`Personal measurements unavailable: ${error.message}. Use Reload saved measurements to retry.`);});
  if(adminRequest)void adminRequest('capabilities',{}).then(result=>{if(!disposed){adminAllowed=result.capabilities?.serverCalculations===true;renderPanel();}}).catch(()=>{adminAllowed=false;});
  renderPanel();
  return {setTool,store,tick:draw,invalidate,isInvalidated:()=>invalidated||store.isInvalidated?.(),modeChanged(){viewGeneration++;void finish();closeDialogs();volumeAbort?.abort();bind(null);renderPanel();},isDrawing:()=>!!draft,dispose(){disposed=true;viewGeneration++;clearInterval(timer);closeDialogs();volumeAbort?.abort();bind(null);controls.remove();message.remove();store.invalidate?.();},getDraft:()=>draft&&draftRecord()};
}
