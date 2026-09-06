import { measurementCollection, measurementMetrics, measurementValue, validateMeasurementGeometry, exportMeasurements } from './measurement-document.mjs';
import { createMeasurementStore } from './measurement-store.mjs';
import './measurement-workspace.css';
import {openSurfaceDialog} from './measurement-volume-dialog.mjs';
import {openAdminCalculationDialog} from './measurement-admin-dialog.mjs';
import {createMeasurementListLayout} from './measurement-list-layout.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field = event => event.target?.closest?.('input,textarea,select,[contenteditable=true]');
const interactive = event => event.target?.closest?.('input,textarea,select,button,a,[contenteditable=true],.leaflet-control,[role=button]');
const savedUnits = {imperial:'imperial',feet:'ft',yards:'yd',metric:'m',centimeters:'cm'};
const restoredUnits = {imperial:'imperial','ft-in':'imperial',ft:'feet',yd:'yards',metric:'metric',m:'metric',cm:'centimeters'};

export function createMeasurementWorkspace({ panel, context, token, permitted, toolChanged, coordinateReference, toLonLat, calculateSurface, adminRequest, onAccessLost=()=>{}, accessGeneration=()=>0 }) {
  let units='imperial',draft=null,selected=null,editing=false,cursor=null,bound=null,gesture=null,space=false,shift=false,lastSvg='',disposed=false,volumeAbort=null,ready=!token(),lastCollection=null;
  const selectedExports=new Set(),reportDialogs=new Set();
  const metricCache=new WeakMap();
  let recordSnapshot=[],recordFamily=null,orderedRecords=[],lastOverlayFrame=null;
  let adminAllowed=false,activeDialog=null,invalidated=false,viewGeneration=0,dialogGeneration=0;
  const store=createMeasurementStore({token,accessGeneration,changed:renderPanel});
  let pendingPick=null,lastPickAt=0,cursorOwner=null,previousCursor='';
  const allowed=()=>permitted()&&!invalidated&&!store.isInvalidated?.();
  const message=document.createElement('p');message.className='measurement-message';message.setAttribute('role','status');
  const controls=document.createElement('div');controls.className='measurement-workspace';
  controls.innerHTML=`<label class="measurement-units">Units <select data-m="units"><option value="imperial">Feet / inches</option><option value="feet">Decimal feet</option><option value="yards">Yards</option><option value="metric">Meters</option><option value="centimeters">Centimeters</option></select></label>
    <div class="measurement-actions measurement-edit-actions" role="group" aria-label="Edit measurement"><button data-m="finish">Finish</button><button data-m="undo">Undo point</button><button data-m="edit">Edit selected</button><button data-m="focus">Focus selected</button></div>
    <details class="measurement-help"><summary>Controls &amp; accuracy</summary><p class="hint">Shift: navigate · Backspace: undo · Space-drag: move vertex · Enter / Esc / right-click: finish</p><p class="hint">Finish a polygon to review its area and surface cut/fill. Volume requires an elevation surface and a verified reference base.</p><p class="hint">Measurements are private to you. Public-link changes reset on refresh. Display precision is not survey accuracy.</p></details>
    <div class="measurement-list-heading"><h4>Saved measurements <span data-m-count>0</span></h4><span class="hint">Newest first</span></div>
    <p class="hint measurement-list-caption">Check Export to include a record. Show / Hide controls its visibility.</p>
    <div data-m-list role="region" aria-label="Saved measurements" tabindex="-1"></div><button class="measurement-reload" data-m="reload">Reload saved measurements</button>
    <section class="measurement-export-section" aria-label="Export measurements"><label class="measurement-units">Export format <select data-m="format"><option value="csv">CSV summary</option><option value="json">JSON data</option><option value="dxf">DXF (meters)</option><option value="geojson">GeoJSON</option></select></label><button data-m="export">Export selected / visible</button>
    <div class="measurement-actions measurement-capture-actions"><button data-m="screenshot">Save view PNG</button><button data-m="report">Print / PDF report</button></div></section>`;
  const listLayout=createMeasurementListLayout(controls.querySelector('[data-m-list]'));
  panel.append(controls,message);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('measurement-overlay');svg.setAttribute('aria-hidden','true');
  const densityNotice=document.createElement('p');densityNotice.className='hint';controls.append(densityNotice);
  function metrics(record){if(record===draft)return measurementMetrics(record);let value=metricCache.get(record);if(!value){value=measurementMetrics(record);metricCache.set(record,value);}return value;}
  function tell(text){message.textContent=text;}
  function records(family=measurementCollection(context()?.mode)){
    if(!allowed())return [];
    const snapshot=[...store.records.values()];
    if(family!==recordFamily||snapshot.length!==recordSnapshot.length||snapshot.some((record,index)=>record!==recordSnapshot[index])){
      recordSnapshot=snapshot;recordFamily=family;
      orderedRecords=snapshot.filter(r=>r.collection===family).reverse().sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
    }
    return orderedRecords;
  }
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
    const visibleRecords=records();
    controls.querySelector('[data-m-count]').textContent=String(visibleRecords.length);
    const focused=controls.ownerDocument?.activeElement;
    const focusedRecord=focused?.closest?.('[data-record]')?.dataset.record;
    const focusedAction=focusedRecord&&focused?.dataset.m;
    const scrollTop=list.scrollTop;
    list.innerHTML=visibleRecords.map(r=>`<article class="measurement-row ${selected===r.id?'selected':''}" data-record="${escape(r.id)}"><div class="measurement-row-heading"><button data-m="select" aria-pressed="${selected===r.id}">${escape(r.name)}</button><label class="measurement-export-check"><input type="checkbox" data-m="export-check" aria-label="Select ${escape(r.name)} for export" ${selectedExports.has(r.id)?'checked':''}> Export</label></div><small class="measurement-row-summary">${escape(summary(r))}</small><small class="measurement-row-status" role="status">${escape(store.statuses.get(r.id)||'')}</small><div class="measurement-actions measurement-row-actions"><button data-m="visibility" title="${r.visible===false?'Show':'Hide'} ${escape(r.name)} on the view">${r.visible===false?'Show':'Hide'}</button><button data-m="rename">Rename</button><button data-m="delete">Delete</button>${r.kind==='polygon'?'<button data-m="volume">Surface cut/fill</button>':''}${r.kind==='polygon'&&adminAllowed?'<button data-m="admin-volume">Admin calculation</button>':''}</div>${Number.isFinite(r.results?.cutM3)?`<small class="measurement-row-result">${escape(r.results.status||'Calculated')}: cut ${escape(measurementValue(r.results.cutM3,3,units))} · fill ${escape(measurementValue(r.results.fillM3,3,units))}</small>`:Number.isFinite(r.results?.volumeM3)?`<small class="measurement-row-result">${escape(r.results.status||'Calculated')}: ${escape(measurementValue(r.results.volumeM3,3,units))}</small>`:''}</article>`).join('')||'<p class="hint measurement-list-empty">No measurements in this view group.<br>Choose Distance or Polygon to start.</p>';
    listLayout.update(visibleRecords.length);
    list.scrollTop=scrollTop;
    if(focusedAction){const row=[...(list.querySelectorAll?.('[data-record]')||[])].find(node=>node.dataset.record===focusedRecord);[...(row?.querySelectorAll('[data-m]')||[])].find(node=>node.dataset.m===focusedAction)?.focus({preventScroll:true});}
    for(const action of ['finish','undo'])controls.querySelector(`[data-m="${action}"]`).disabled=!draft;
    for(const action of ['edit','focus'])controls.querySelector(`[data-m="${action}"]`).disabled=!store.records.has(selected);
    controls.querySelector('[data-m="reload"]').hidden=!token();
  }
  function draftRecord(){return {...draft,vertices:draft.vertices.map(p=>p.slice())};}
  function releaseCursor(){if(cursorOwner){cursorOwner.style.cursor=previousCursor;cursorOwner=null;}}
  function updateCursor(){if(!bound?.element)return;const element=bound.element;element.classList.toggle('measurement-placing',!!draft&&!shift);element.classList.toggle('measurement-navigating',!!draft&&shift);element.classList.toggle('measurement-editing',!!draft&&!shift&&(editing||space));if(draft){if(cursorOwner!==element){releaseCursor();cursorOwner=element;previousCursor=element.style.cursor||'';}element.style.cursor=shift?'grab':editing||space?'move':'crosshair';}else releaseCursor();}
  function disarm(){draft=null;editing=false;cursor=null;gesture=null;space=false;pendingPick=null;updateCursor();toolChanged('none');renderPanel();}
  function closeReports(){for(const dialog of [...reportDialogs])dialog.retire();}
  function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;closeReports();}
  function invalidate(reason='Personal measurements unavailable.',{notify=true}={}){
    if(invalidated)return;invalidated=true;viewGeneration++;ready=false;adminAllowed=false;selected=null;selectedExports.clear();disarm();closeDialogs();store.invalidate?.();svg.innerHTML='';lastSvg='';controls.hidden=true;tell(reason);if(notify)onAccessLost();
  }
  function showSurface(record,{autoCalculate=false}={}){
    if(!record||record.kind!=='polygon'||!allowed()||disposed||typeof calculateSurface!=='function')return;
    let snapshot=structuredClone(record);
    closeDialogs();
    const generation=viewGeneration,dialogId=dialogGeneration;
    const isCurrent=()=>!disposed&&allowed()&&generation===viewGeneration&&dialogId===dialogGeneration;
    activeDialog=openSurfaceDialog({record,units,autoCalculate,
      calculate:async(...args)=>{if(!isCurrent())throw new Error('Measurement access or view changed.');const result=await calculateSurface(...args);if(!isCurrent())throw new Error('Measurement access or view changed.');return result;},
      save:async r=>{if(!isCurrent())throw new Error('Measurement access or view changed.');await store.attachResults(snapshot,r.results);if(isCurrent())snapshot=structuredClone(store.records.get(record.id));},
      onClose:()=>{if(dialogId===dialogGeneration)activeDialog=null;}
    });
  }
  async function finish({openVolume=true}={}){
    if(!draft)return;
    if(disposed||!allowed()){disarm();return;}
    if(draft.vertices.length<(draft.kind==='polygon'?3:2)){disarm();tell('Incomplete measurement cancelled.');return;}
    const record={...draftRecord(),displayPreferences:{...draft.displayPreferences,units:savedUnits[units]}},generation=viewGeneration,dialogId=dialogGeneration,mode=context()?.mode;
    try{record.results={...measurementMetrics(record),status:'geometry-only',method:'vertex-geometry',...(record.collection==='map'?{elevationBasis:'not-sampled',warnings:['Map geometry is two-dimensional; stored Z=0 is a placeholder, not measured elevation. Surface calculations sample native elevations separately.']}:{} )};validateMeasurementGeometry(record);selected=record.id;disarm();await store.save(record);if(disposed||!allowed()||generation!==viewGeneration)return;tell(store.persistent()?'Measurement saved privately.':'Temporary measurement — resets on refresh.');
      if(openVolume&&record.kind==='polygon'&&!draft&&selected===record.id&&dialogId===dialogGeneration&&mode===context()?.mode)showSurface(store.records.get(record.id),{autoCalculate:true});}
    catch(error){tell(error.message);}
  }
  function setTool(tool){
    if(!allowed())return;
    if(!ready){tell('Wait for your saved measurements to load.');return;}
    if(tool==='clear'){tell('Select an individual measurement and use Delete.');return;}
    if(tool==='none'){void finish();return;}
    if(draft){tell('Finish the current measurement before starting another.');return;}
    closeDialogs();
    const family=measurementCollection(context()?.mode),kind=tool==='distance'?'distance':'polygon';
    const sourceMode=context()?.mode;
    draft={id:crypto.randomUUID(),name:`${kind==='distance'?'Distance':'Polygon'} ${records().length+1}`,kind,collection:family,vertices:[],coordinateReference:coordinateReference(),visible:true,source:{kind:sourceMode==='model'?'mesh':sourceMode==='cloud'?'pointCloud':sourceMode}};
    editing=false;updateCursor();renderPanel();toolChanged(tool==='volume'?'area':tool);tell('Click to place points. Hold Shift to navigate.');
  }
  function editRecord(record){if(!record)return;closeDialogs();draft=structuredClone(record);editing=true;selected=record.id;cursor=null;updateCursor();renderPanel();toolChanged('edit');tell('Drag a vertex to adjust it. Shift navigates; Finish saves.');}
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
    pendingPick={clientX:event.clientX,clientY:event.clientY};
    if(gesture)stop(event);
  }
  function pointerUp(event){
    if(!allowed()){disarm();return;}
    if(!gesture)return;
    const g=gesture;gesture=null;stop(event);
    pendingPick=null;
    if(g.index>=0){const point=bound.pick(event);if(point)draft.vertices[g.index]=point;}
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
    if(event.key==='Shift'){shift=true;pendingPick=null;updateCursor();}
    if(!draft)return;
    if(event.code==='Space'){space=true;updateCursor();stop(event);}
    else if(event.key==='Backspace'){draft.vertices.pop();cursor=null;stop(event);}
    else if(event.key==='Escape'||event.key==='Enter'){stop(event);void finish();}
  }
  function keyUp(event){if(event.code==='Space')space=false;if(event.key==='Shift')shift=false;updateCursor();}
  function blur(){gesture=null;space=false;shift=false;cursor=null;pendingPick=null;updateCursor();}
  const contextMenu=e=>{if(draft&&!e.shiftKey)stop(e);};
  function bind(next){
    if(bound?.element===next?.element){bound=next;return;}
    if(bound){for(const [event,fn]of handlers)bound.element.removeEventListener(event,fn,true);bound.element.ownerDocument.defaultView.removeEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.removeEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.removeEventListener('blur',blur);}
    bound?.element.classList.remove('measurement-placing','measurement-navigating','measurement-editing');
    releaseCursor();svg.remove();svg.innerHTML='';bound=next;lastSvg=null;pendingPick=null;
    if(!bound)return;
    bound.host.append(svg);
    updateCursor();
    for(const [event,fn]of handlers)bound.element.addEventListener(event,fn,true);
    bound.element.ownerDocument.defaultView.addEventListener('keydown',keyDown,true);bound.element.ownerDocument.defaultView.addEventListener('keyup',keyUp,true);bound.element.ownerDocument.defaultView.addEventListener('blur',blur);
  }
  const handlers=[['pointerdown',pointerDown],['pointermove',pointerMove],['pointerup',pointerUp],['pointercancel',blur],['contextmenu',contextMenu],['dblclick',e=>{if(draft)stop(e);}]];
  function draw({force=false}={}){
    if(disposed)return;
    bind(context());
    const collection=measurementCollection(bound?.mode);
    if(collection!==lastCollection){lastCollection=collection;selected=null;selectedExports.clear();renderPanel();}
    if(!permitted()){invalidate('Personal measurements are hidden until access is restored.');return;}
    if(!bound||!allowed()){if(!allowed()&&draft)disarm();if(lastSvg!=='')svg.innerHTML='';lastSvg='';lastOverlayFrame=null;return;}
    if(pendingPick&&draft&&!shift&&performance.now()-lastPickAt>=66){const event=pendingPick;pendingPick=null;lastPickAt=performance.now();const point=bound.pick(event);if(point){if(gesture?.index>=0)draft.vertices[gesture.index]=point;else if(!editing)cursor=point;}}
    const all=records(collection).filter(r=>r.visible!==false&&r.id!==draft?.id).sort((a,b)=>Number(b.id===selected)-Number(a.id===selected));if(draft)all.unshift(draft);
    // Empty collections still check access above, but must not force layout,
    // camera projection or SVG mutation alongside a dense Potree render.
    if(!all.length){if(lastSvg!=='')svg.innerHTML='';lastSvg='';lastOverlayFrame=null;if(densityNotice.textContent) densityNotice.textContent='';return;}
    const signature=bound.viewSignature?.();
    const draftSignature=draft?JSON.stringify([draft.id,draft.vertices,cursor,editing]):null;
    if(!force&&typeof signature==='string'&&lastOverlayFrame&&lastOverlayFrame.element===bound.element&&lastOverlayFrame.mode===bound.mode&&lastOverlayFrame.generation===viewGeneration&&lastOverlayFrame.signature===signature&&lastOverlayFrame.units===units&&lastOverlayFrame.selected===selected&&lastOverlayFrame.draft===draftSignature&&lastOverlayFrame.records.length===all.length&&all.every((record,index)=>record===lastOverlayFrame.records[index]))return;
    const rect=bound.element.getBoundingClientRect(),viewBox=`0 0 ${rect.width} ${rect.height}`;
    if(svg.getAttribute?.('viewBox')!==viewBox)svg.setAttribute('viewBox',viewBox);
    lastOverlayFrame={element:bound.element,mode:bound.mode,generation:viewGeneration,signature,units,selected,draft:draftSignature,records:all};
    let markup='',displayVertices=0,labelCount=0,decluttered=false;const labelBoxes=[];
    for(const r of all){
      if(displayVertices+r.vertices.length>5000){decluttered=true;continue;}
      displayVertices+=r.vertices.length;
      const vertices=r.vertices.slice();if(r===draft&&cursor&&!editing)vertices.push(cursor);
      const positions=vertices.map(p=>bound.project(p,rect));if(!positions.length||positions.some(p=>!p))continue;
      if(positions.every(p=>p[0]<0)||positions.every(p=>p[0]>rect.width)||positions.every(p=>p[1]<0)||positions.every(p=>p[1]>rect.height))continue;
      const points=positions.map(p=>`${p[0]},${p[1]}`).join(' '),closed=r.kind==='polygon'&&positions.length>=3;
      markup+=`<${closed?'polygon':'polyline'} points="${points}" fill="${closed?'#ee5007':'none'}" fill-opacity="0.12" stroke="${r.id===selected?'#fff':'#f8cb2e'}" stroke-width="2"/>`;
      for(let i=0;i<r.vertices.length;i++){const p=positions[i];markup+=`<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#ee5007" stroke="#fff" stroke-width="1"/>`;}
      const text=(x,y,value)=>{const half=String(value).length*3.5+5,box=[x-half,y-13,x+half,y+4];if(++labelCount>200||labelBoxes.some(b=>box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1])){decluttered=true;return '';}labelBoxes.push(box);return `<text x="${x}" y="${y}" text-anchor="middle" fill="white" stroke="#121212" stroke-width="4" paint-order="stroke" font-size="12" font-family="sans-serif">${escape(value)}</text>`;};
      if(vertices.length>=2){const lengths=(r===draft?measurementMetrics({...r,vertices}):metrics(r)).edgeLengthsM;for(let i=0;i<lengths.length;i++){const a=positions[i],b=positions[(i+1)%positions.length];if(Math.hypot(a[0]-b[0],a[1]-b[1])<90&&r!==draft&&r.id!==selected){decluttered=true;continue;}markup+=text((a[0]+b[0])/2,(a[1]+b[1])/2-7,measurementValue(lengths[i],1,units));}}
      if(r!==draft){const center=positions.reduce((s,p)=>[s[0]+p[0]/positions.length,s[1]+p[1]/positions.length],[0,0]);markup+=text(center[0],center[1]+15,r.name);if(closed)markup+=text(center[0],center[1]+30,measurementValue(metrics(r).horizontalAreaM2,2,units)+' horizontal');}
      if(r!==draft&&(Number.isFinite(r.results?.volumeM3)||Number.isFinite(r.results?.cutM3))){
        const center=positions.reduce((s,p)=>[s[0]+p[0]/positions.length,s[1]+p[1]/positions.length],[0,0]);
        const quantity=Number.isFinite(r.results.volumeM3)?`${r.results.estimated||r.results.status==='estimate'||r.results.method==='reconstructed-estimate'?'Estimated ':''}volume ${measurementValue(r.results.volumeM3,3,units)}`:`Cut ${measurementValue(r.results.cutM3,3,units)} · Fill ${measurementValue(r.results.fillM3,3,units)}`;
        markup+=text(center[0],center[1]+46,quantity);
      }
    }
    const densityText=decluttered?'Display decluttered for responsiveness. Select a measurement to prioritize it, or hide others. Saved geometry and calculations are unchanged.':'';
    if(densityNotice.textContent!==densityText)densityNotice.textContent=densityText;
    if(markup!==lastSvg){svg.innerHTML=markup;lastSvg=markup;}
  }
  const timer=setInterval(draw,33);
  function download(content,name,type){const url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function exportRecords(){const candidates=records();return selectedExports.size?candidates.filter(r=>selectedExports.has(r.id)):candidates.filter(r=>r.visible!==false);}
  async function screenshot(){
    draw({force:true});if(!bound||!allowed())throw new Error('View is not ready or access is unavailable.');
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
  controls.addEventListener('change',event=>{if(event.target.dataset.m==='units'){units=event.target.value;const record=store.records.get(selected);if(record&&!draft)void store.patch(record,{displayPreferences:{...record.displayPreferences,units:savedUnits[units]}}).catch(error=>tell(error.message));renderPanel();}if(event.target.dataset.m==='export-check'){const id=event.target.closest('[data-record]').dataset.record;event.target.checked?selectedExports.add(id):selectedExports.delete(id);}});
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
      if(action==='visibility')await store.patch(record,{visible:record.visible===false});
      if(action==='delete'){await store.remove(id);selectedExports.delete(id);if(draft?.id===id)disarm();}
      if(action==='rename'){
        const row=event.target.closest('[data-record]'),editor=document.createElement('form');editor.className='measurement-rename';editor.innerHTML='<label>Measurement name <input name="name" maxlength="160" required></label><div class="measurement-actions"><button type="submit">Save name</button><button type="button" data-cancel>Cancel</button></div>';
        const input=editor.querySelector('input');input.value=record.name;row.append(editor);input.focus();input.select();
        editor.querySelector('[data-cancel]').onclick=()=>renderPanel();editor.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();renderPanel();}};
        editor.onsubmit=async e=>{e.preventDefault();const name=input.value.trim();if(!name)return;editor.querySelector('[type=submit]').disabled=true;try{await store.patch(record,{name});tell('Measurement name saved.');}catch(error){tell(error.message);editor.querySelector('[type=submit]').disabled=false;}};
      }
      if(action==='export'){const format=controls.querySelector('[data-m="format"]').value;download(exportMeasurements(exportRecords(),format,{toLonLat,units}),`measurements.${format}`,format==='json'||format==='geojson'?'application/json':'text/plain');}
      if(action==='screenshot'){const generation=viewGeneration,displayUnits=units;const canvas=await screenshot();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(disposed||!allowed()||generation!==viewGeneration||displayUnits!==units)throw new Error('The view changed during capture. Capture the current view again.');if(!blob)throw new Error('View capture unavailable.');download(blob,'measured-view.png');}
      if(action==='report')await report();
      if(action==='volume')showSurface(record);
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
  return {setTool,store,tick:draw,invalidate,isInvalidated:()=>invalidated||store.isInvalidated?.(),modeChanged(){viewGeneration++;void finish({openVolume:false});closeDialogs();volumeAbort?.abort();bind(null);renderPanel();},isDrawing:()=>!!draft,dispose(){disposed=true;listLayout.dispose();viewGeneration++;clearInterval(timer);closeDialogs();volumeAbort?.abort();bind(null);controls.remove();message.remove();store.invalidate?.();},getDraft:()=>draft&&draftRecord()};
}
