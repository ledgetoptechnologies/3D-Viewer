import {TASK_PHOTO_ACCEPT,inspectTaskPhotos,prepareTaskPhotos,uploadTaskPhotos} from './workspace-task-upload.mjs';
import {providerSubmissionState,selectSubmissionProvider} from './server/providerSelection.mjs';
import {mountPhotoMap} from './workspace-task-photo-map.mjs';
import {mountTaskOptions} from './workspace-task-options.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function defaultTaskName(project,date=new Date()){
  return `${project.displayName} - ${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`.slice(0,240);
}

// A dialog-scoped controller. Closing aborts browser transfers/observation, not
// an already accepted durable copy or finalization operation.
export function mountNewTask({container,dialog,project,providers=[],presets=[],datasets=[],api,token,onComplete=()=>{},canUpload=true,canImport=true}){
  const controller=new AbortController(),{signal}=controller;
  dialog.classList.add('new-task-modal');
  let source='pc',files=[],selectedPaths=new Set(),busy=false,datasetId='',currentProviders=providers,submissionId=crypto.randomUUID(),copyKey=crypto.randomUUID();
  let prepared=null,browseGeneration=0,sourceOperation=null,datasetKey=crypto.randomUUID(),submissionFingerprint='';
  const ready=datasets.filter(item=>item.projectId===project.id&&item.status==='finalized');
  container.insertAdjacentHTML('beforeend',`<form class="manage-form new-task-form">
    <label>Task name<input name="taskDisplayName" required maxlength="240" value="${escape(defaultTaskName(project))}"></label>
    <fieldset><legend>Photos</legend><div class="row-actions task-source-actions">
      ${canUpload?'<button type="button" data-source="pc">Select from PC</button>':''}
      ${canImport?'<button type="button" data-source="server">Select from server storage</button>':''}
      ${ready.length?'<button type="button" data-source="existing">Use saved source</button>':''}
    </div>
    <section data-source-panel="pc"><input data-files type="file" multiple accept="${escape(TASK_PHOTO_ACCEPT)}" hidden><input data-folder type="file" multiple webkitdirectory hidden><p class="form-note task-folder-alternate">Or <button type="button" class="text-button" data-choose-folder>choose a parent folder</button> to include photos in its subfolders. Originals stay unchanged.</p></section>
    <section data-source-panel="server" hidden><div data-server-browser aria-live="polite"></div><p class="form-note">Select photos or folders from the import mount, including raw/. Selected folders include all nested photos. Originals remain in place.</p></section>
    <section data-source-panel="existing" hidden><label>Saved source<select name="existingDataset"><option value="">Choose saved source</option>${ready.map(item=>`<option value="${escape(item.id)}">${escape(item.displayName)}</option>`).join('')}</select></label></section>
    <p data-selection role="status">No photos selected.</p><div data-photo-map hidden></div></fieldset>
    <label>Processing node<select name="providerId" required></select></label><p data-provider-note class="form-note"></p>
    <label>Processing preset (optional)<select name="presetId"><option value="">Node defaults</option></select></label>
    <div data-task-options></div>
    <p class="form-note">Photos keep their original size. Choose an existing preset or use node defaults.</p>
    <progress data-progress hidden></progress><p data-status role="status" aria-live="polite"></p>
    <button class="primary-button" type="submit">Start processing</button>
  </form>`);
  const form=container.querySelector('.new-task-form'),status=form.querySelector('[data-status]'),selection=form.querySelector('[data-selection]'),node=form.elements.providerId,progress=form.querySelector('progress');
  const taskOptions=mountTaskOptions({container:form.querySelector('[data-task-options]')});
  function syncTaskOptions(){taskOptions.update({provider:currentProviders.find(item=>item.id===node.value),presetOptions:presets.find(item=>item.id===form.elements.presetId.value)?.options||{}});}
  const photoMapHost=form.querySelector('[data-photo-map]');let photoMap=null,previewAbort=null,previewTimer=null,previewGeneration=0;
  function clearPhotoPreview(){previewGeneration++;clearTimeout(previewTimer);previewTimer=null;previewAbort?.abort();previewAbort=null;photoMap?.dispose();photoMap=null;photoMapHost.replaceChildren();photoMapHost.hidden=true;}
  function schedulePhotoPreview(){
    clearPhotoPreview();
    if(signal.aborted||source==='existing'||(source==='pc'?!files.length:!selectedPaths.size))return;
    const generation=previewGeneration;
    previewTimer=setTimeout(()=>{previewTimer=null;void loadPhotoPreview(generation);},200);
  }
  async function loadPhotoPreview(generation){
    if(signal.aborted||generation!==previewGeneration)return;
    const local=new AbortController();previewAbort=local;const abort=()=>local.abort();signal.addEventListener('abort',abort,{once:true});
    const current=()=>!local.signal.aborted&&!signal.aborted&&generation===previewGeneration;
    try{photoMapHost.hidden=false;photoMap=mountPhotoMap(photoMapHost);const map=photoMap;
      if(source==='pc')await map.setFiles(inspectTaskPhotos(files).items.map(item=>item.file),{signal:local.signal});
      else{const result=await api('/api/v1/dataset-imports/photo-preview',{method:'POST',body:{paths:[...selectedPaths]},signal:local.signal});if(current())await map.setLocations(result,{signal:local.signal});}
    }catch(error){if(current()){photoMap?.dispose();photoMap=null;photoMapHost.textContent='Photo locations could not be previewed. Your selection is unchanged.';}}
    finally{signal.removeEventListener('abort',abort);if(previewAbort===local)previewAbort=null;}
  }
  const say=message=>{if(!signal.aborted)status.textContent=message;};
  function providerOptions(){const selected=selectSubmissionProvider(currentProviders,node.value);node.innerHTML='<option value="">Choose available node</option>'+currentProviders.map(item=>{const availability=providerSubmissionState(item);return `<option value="${escape(item.id)}" ${availability.eligible?'':'disabled'}>${escape(item.displayName)} — ${escape(availability.label)}</option>`;}).join('');node.value=selected;providerNote();}
  const compatiblePreset=(preset,provider)=>Boolean(provider&&preset.enabled&&(!preset.providerType||preset.providerType===provider.type)&&(!preset.capabilityFingerprint||preset.capabilityFingerprint===provider.capabilityFingerprint));
  function providerNote(){const item=currentProviders.find(item=>item.id===node.value);form.querySelector('[data-provider-note]').textContent=item?providerSubmissionState(item).label:'No available node selected. Configure or refresh nodes under Providers & nodes.';const preset=form.elements.presetId,previous=preset.value,eligible=presets.filter(p=>compatiblePreset(p,item));preset.innerHTML='<option value="">Node defaults</option>'+eligible.map(p=>`<option value="${escape(p.id)}">${escape(p.displayName)}</option>`).join('');preset.value=eligible.some(p=>p.id===previous)?previous:'';syncTaskOptions();}
  function setBusy(value){busy=value;for(const element of form.querySelectorAll('input,select,button'))if(!element.closest('[data-task-options]'))element.disabled=value;taskOptions.setDisabled(value);progress.hidden=!value;if(!value)providerOptions();}
  function resetSource(){clearPhotoPreview();datasetId='';prepared=null;sourceOperation=null;submissionFingerprint='';datasetKey=crypto.randomUUID();submissionId=crypto.randomUUID();copyKey=crypto.randomUUID();}
  function selectFiles(list){if(busy||!list?.length)return;resetSource();files=[...list];try{const info=inspectTaskPhotos(files);selection.textContent=`${info.items.length.toLocaleString()} ${info.items.length===1?'photo':'photos'} selected${info.ignored.length?`; ${info.ignored.length} unsupported files skipped`:''}${info.renamed.length?`; ${info.renamed.length} duplicate filenames will be renamed in the processing copy`:''}.`;say('');schedulePhotoPreview();}catch(error){files=[];selection.textContent='No valid selection.';say(error.message);}}
  async function browse(path='',offset=0){if(busy||signal.aborted||source!=='server')return;const generation=++browseGeneration,host=form.querySelector('[data-server-browser]'),usable=()=>!busy&&!signal.aborted&&source==='server'&&generation===browseGeneration;host.textContent='Loading folders…';try{const page=await api(`/api/v1/dataset-imports/browse?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`,{signal});if(signal.aborted||source!=='server'||generation!==browseGeneration)return;host.innerHTML=`<div class="row-actions">${path?'<button type="button" data-parent>Up one folder</button><button type="button" data-select-folder>Select this folder</button>':''}</div><p>${escape(page.path||'Import folder')}</p><div class="task-source-browser">${page.entries.map((item,index)=>`<div><label><input type="checkbox" data-pick="${index}" ${selectedPaths.has(item.relativePath)?'checked':''}>${escape(item.name)}</label>${item.kind==='folder'?`<button type="button" data-open="${index}">Open folder</button>`:''}</div>`).join('')||'<p>No photos or folders here.</p>'}</div>${page.nextOffset!=null?'<button type="button" data-next>Next page</button>':''}`;
      for(const control of host.querySelectorAll('button,input'))control.disabled=busy;
      const update=()=>{resetSource();selection.textContent=`${selectedPaths.size} server selections. Folders will be scanned recursively.`;schedulePhotoPreview();};
      host.querySelector('[data-parent]')?.addEventListener('click',()=>{if(usable())void browse(page.parentPath||'');});host.querySelector('[data-select-folder]')?.addEventListener('click',()=>{if(!usable())return;selectedPaths.add(page.path);update();void browse(page.path,offset);});host.querySelector('[data-next]')?.addEventListener('click',()=>{if(usable())void browse(page.path,page.nextOffset);});
      host.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>{if(usable())void browse(page.entries[Number(button.dataset.open)].relativePath);});host.querySelectorAll('[data-pick]').forEach(input=>input.onchange=()=>{const path=page.entries[Number(input.dataset.pick)].relativePath;if(!usable()){input.checked=selectedPaths.has(path);return;}if(input.checked)selectedPaths.add(path);else selectedPaths.delete(path);update();});
    }catch(error){if(!signal.aborted&&source==='server'&&generation===browseGeneration)host.textContent=error.message;}}
  async function waitOperation(operation){let item=operation;if(!item?.id)throw new Error('Source preparation did not return a background operation.');while(!['succeeded','complete','completed','failed','cancelled'].includes(item.status)){if(signal.aborted)throw new DOMException('Cancelled','AbortError');say('Preparing your source photos. You may close this window; accepted server work remains in Background work. Reopen New task and use the saved source once ready.');await new Promise((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,1500),abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};signal.addEventListener('abort',abort,{once:true});});item=(await api(`/api/v1/operations/${encodeURIComponent(item.id)}`,{signal})).operation;if(!item?.id)throw new Error('Source preparation status is unavailable.');sourceOperation=item;}if(!['succeeded','complete','completed'].includes(item.status))throw new Error(item.errorMessage||item.error?.message||'Source preparation failed. Check Background work before retrying.');}
  form.querySelector('[data-files]').onchange=event=>selectFiles(event.target.files);form.querySelector('[data-folder]').onchange=event=>selectFiles(event.target.files);node.onchange=providerNote;
  form.elements.presetId.onchange=syncTaskOptions;
  form.elements.existingDataset.onchange=()=>{resetSource();selection.textContent='Saved source selected.';};
  function openPicker(selector){if(busy)return;const input=form.querySelector(selector);input.value='';input.click();}
  form.querySelector('[data-choose-folder]').onclick=()=>openPicker('[data-folder]');
  form.querySelectorAll('[data-source]').forEach(button=>button.onclick=()=>{if(busy)return;const changed=source!==button.dataset.source;source=button.dataset.source;if(changed){resetSource();files=[];selectedPaths.clear();selection.textContent='Select photos or a source folder.';}form.querySelectorAll('[data-source-panel]').forEach(panel=>panel.hidden=panel.dataset.sourcePanel!==source);form.querySelectorAll('[data-source]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));if(source==='server')void browse();else if(source==='pc')openPicker('[data-files]');});
  form.onsubmit=async event=>{event.preventDefault();if(busy)return;const name=form.elements.taskDisplayName.value.trim(),providerId=node.value;if(!name||!providerId)return say('Enter a task name and choose an available processing node.');
    if(source==='pc'&&!files.length||source==='server'&&!selectedPaths.size||source==='existing'&&!form.elements.existingDataset.value)return say('Select source photos first.');
    if(!taskOptions.validate().valid)return say('Check the highlighted processing options before starting.');
    let options;try{options=taskOptions.getOptions();}catch(error){return say(error.message);}
    const presetId=form.elements.presetId.value,capabilityFingerprint=currentProviders.find(item=>item.id===providerId)?.capabilityFingerprint;setBusy(true);try{currentProviders=(await api('/api/v1/processing/providers?limit=100',{signal})).providers||[];const provider=currentProviders.find(item=>item.id===providerId);if(!provider||!providerSubmissionState(provider).eligible)throw new Error('The selected node is not currently available. Refresh or choose another node.');if(provider.capabilityFingerprint!==capabilityFingerprint)throw new Error('The node options changed. Review the refreshed settings before starting.');if(presetId&&!presets.some(p=>p.id===presetId&&compatiblePreset(p,provider)))throw new Error('The selected preset no longer matches this node. Choose another preset.');
      if(source==='existing')datasetId=form.elements.existingDataset.value;
      else if(source==='pc'){const existing=datasetId?(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset:null;if(existing?.status!=='finalized'){if(sourceOperation)await waitOperation(sourceOperation);else{prepared??=await prepareTaskPhotos(files,{signal,onProgress:item=>say(`Checking photos: ${item.completed||0} / ${item.total||files.length}`)});if(!datasetId)datasetId=(await api('/api/v1/datasets',{method:'POST',headers:{'Idempotency-Key':datasetKey},body:{projectId:project.id,displayName:name},signal})).dataset.id;
        const result=await uploadTaskPhotos({datasetId,prepared,api,token,signal,onProgress:item=>say(item.phase==='uploading'?`Uploading photos: ${Math.round(100*item.completedBytes/Math.max(1,item.totalBytes))}%`:'Preparing source photos…')});sourceOperation=result.operation;await waitOperation(sourceOperation);}}
      }else {if(!datasetId){const result=await api('/api/v1/dataset-imports/copy',{method:'POST',headers:{'Idempotency-Key':copyKey},body:{projectId:project.id,displayName:name,paths:[...selectedPaths]},signal});datasetId=result.dataset.id;sourceOperation=result.operation;}const existing=(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset;if(existing?.status!=='finalized')await waitOperation(sourceOperation);}
      const dataset=(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset;if(dataset?.status!=='finalized')throw new Error('Source is still preparing. Check Background work, then use this saved source when ready.');
      if(signal.aborted)return;
      currentProviders=(await api('/api/v1/processing/providers?limit=100',{signal})).providers||[];
      const finalProvider=currentProviders.find(item=>item.id===providerId);
      if(!finalProvider||!providerSubmissionState(finalProvider).eligible)throw new Error('The selected node is no longer available. Choose an available node before starting.');
      if(finalProvider.capabilityFingerprint!==capabilityFingerprint)throw new Error('The node options changed while preparing photos. Review the refreshed settings before starting.');
      if(signal.aborted)return;const fingerprint=JSON.stringify([datasetId,name,providerId,presetId,options]);if(submissionFingerprint&&submissionFingerprint!==fingerprint)submissionId=crypto.randomUUID();submissionFingerprint=fingerprint;
      say('Submitting processing task…');const result=await api('/api/v1/task-submissions',{method:'POST',headers:{'Idempotency-Key':submissionId},body:{submissionId,projectId:project.id,datasetId,taskDisplayName:name,providerId,...(presetId?{presetId}:{}),options},signal});if(!signal.aborted){dialog.close();await onComplete(result);}
    }catch(error){if(!signal.aborted)say(`${error.message}${datasetId?' Your source dataset is retained; no original files were removed.':''}`);}finally{if(!signal.aborted)setBusy(false);}};
  const close=()=>{controller.abort();clearPhotoPreview();taskOptions.dispose();dialog.classList.remove('new-task-modal');};dialog.addEventListener('close',close,{once:true});providerOptions();
  void api('/api/v1/processing/providers?limit=100',{signal}).then(result=>{if(!signal.aborted&&!busy){currentProviders=result.providers||[];providerOptions();}}).catch(error=>{if(!signal.aborted&&!busy)say(`Could not refresh processing nodes: ${error.message}`);});
  if(!canUpload){source=canImport?'server':'existing';form.querySelectorAll('[data-source-panel]').forEach(panel=>panel.hidden=panel.dataset.sourcePanel!==source);if(source==='server')void browse();}
  form.querySelectorAll('[data-source]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.source===source)));
  return {dispose(){close();dialog.removeEventListener('close',close);}};
}
