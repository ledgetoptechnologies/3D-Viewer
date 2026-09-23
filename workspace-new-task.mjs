import {TASK_PHOTO_ACCEPT,inspectTaskPhotos,prepareTaskPhotos,uploadTaskPhotos} from './workspace-task-upload.mjs';
import {providerSubmissionState,selectSubmissionProvider} from './server/providerSelection.mjs';
import {mountPhotoMap} from './workspace-task-photo-map.mjs';
import {mountTaskOptions} from './workspace-task-options.mjs';
import './workspace-task-workflow.css';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function defaultTaskName(project,date=new Date()){
  return `${project.displayName} - ${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`.slice(0,240);
}

// A browser-owned controller. In background mode, closing hides the dialog
// while submission continues; explicit disposal still aborts local work.
// Accepted durable copy/finalization operations are never silently cancelled.
export function mountNewTask({container,dialog,project,providers=[],presets=[],datasets=[],api,token,onComplete=()=>{},onDispose=()=>{},canUpload=true,canImport=true,canManagePresets=false,allowBackground=false}){
  const controller=new AbortController(),{signal}=controller;
  dialog.classList.add('new-task-modal');
  let source='pc',files=[],selectedPaths=new Set(),busy=false,datasetId='',currentProviders=providers,submissionId=crypto.randomUUID(),copyKey=crypto.randomUUID();
  let prepared=null,browseGeneration=0,sourceOperation=null,datasetKey=crypto.randomUUID(),submissionFingerprint='';
  const ready=datasets.filter(item=>item.projectId===project.id&&item.status==='finalized');
  container.insertAdjacentHTML('beforeend',`<form class="manage-form new-task-form">
    <label>Task name<input name="taskDisplayName" required maxlength="240" value="${escape(defaultTaskName(project))}"></label>
    <fieldset><legend>Photos</legend><div class="row-actions task-source-actions">
      ${canUpload?'<button type="button" data-source="pc">Choose files</button><button type="button" data-choose-folder>Choose folder</button>':''}
      ${canImport?'<button type="button" data-source="server">Select from server storage</button>':''}
      ${ready.length?'<button type="button" data-source="existing">Use saved source</button>':''}
    </div>
    <section data-source-panel="pc"><input data-files type="file" multiple accept="${escape(TASK_PHOTO_ACCEPT)}" hidden><input data-folder type="file" multiple webkitdirectory hidden><p class="form-note">Choose individual photos or a folder including its subfolders. Originals stay unchanged.</p></section>
    <section data-source-panel="server" hidden><div data-server-browser aria-live="polite"></div><p class="form-note">Select photos or folders from the import mount, including raw/. Selected folders include all nested photos. Originals remain in place.</p></section>
    <section data-source-panel="existing" hidden><label>Saved source<select name="existingDataset"><option value="">Choose saved source</option>${ready.map(item=>`<option value="${escape(item.id)}">${escape(item.displayName)}</option>`).join('')}</select></label></section>
    <p data-selection role="status">No photos selected.</p><div data-photo-map hidden></div></fieldset>
    <label>Processing node<select name="providerId" required></select></label><p data-provider-note class="form-note"></p>
    <label>Processing preset (optional)<select name="presetId"><option value="">Node defaults</option></select></label>
    <div class="row-actions"><button type="button" data-edit-options>Edit task options</button>${canManagePresets?'<button type="button" data-preset-open>Save as preset…</button>':''}</div>
    ${canManagePresets?'<fieldset data-preset-save hidden><legend>Save these settings as a preset</legend><label>Preset name<input name="newPresetName" maxlength="240"></label><p class="form-note">Saves the selected preset plus your changes. Your existing preset stays unchanged.</p><div class="row-actions"><button type="button" data-preset-save-button>Save new preset</button><button type="button" data-preset-cancel>Cancel</button></div><p data-preset-status role="status"></p></fieldset>':''}
    <label>Alignment<select name="alignment"><option value="automatic">Automatic · use photo coordinates</option></select></label><p class="form-note">Alignment to an earlier survey requires a registered reference file and is not available in this workflow yet.</p>
    <div data-task-options></div>
    <p class="form-note">Photos keep their original size. Changes apply only to this task unless you save a new preset.</p>
    <progress data-progress aria-label="Photo preparation and upload progress" max="100" value="0" hidden></progress><p data-status role="status" aria-live="polite"></p>
    ${allowBackground?'<button type="button" data-background hidden>Continue in background</button>':''}
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
  const doc=container.ownerDocument,view=doc.defaultView;let completed=false,disposed=false,presetSaving=false,transferPanel=null,presetRequestKey='',presetRequestFingerprint='';
  const leaveWarning=event=>{if(busy){event.preventDefault();event.returnValue='';}};
  function reopen(){if(!signal.aborted&&!dialog.open)dialog.showModal();}
  function updateTransfer(){if(!allowBackground||presetSaving)return;if(!transferPanel&&busy){transferPanel=doc.createElement('aside');transferPanel.className='task-transfer-tray';transferPanel.setAttribute('aria-label','Active photo upload');transferPanel.innerHTML='<strong></strong><p role="status"></p><progress max="100" value="0" aria-label="Photo transfer progress"></progress><div class="row-actions"><button type="button" data-show-upload>View upload</button><button type="button" data-discard-upload title="Stops this browser upload and task submission. Accepted server preparation may continue; original photos and retained source data are not deleted.">Stop / discard</button></div>';transferPanel.querySelector('[data-show-upload]').onclick=reopen;transferPanel.querySelector('[data-discard-upload]').onclick=()=>{dispose();dialog.close();};doc.body.append(transferPanel);}if(transferPanel){transferPanel.querySelector('strong').textContent=form.elements.taskDisplayName.value;transferPanel.querySelector('p').textContent=status.textContent;transferPanel.querySelector('progress').value=progress.value;transferPanel.querySelector('progress').hidden=!busy;}}
  const say=message=>{if(!signal.aborted){status.textContent=message;updateTransfer();}};
  function showProgress(item){const total=item.total||files.length,done=item.completed||0;let message;if(item.phase==='preparing'){progress.value=100*done/Math.max(1,total);message=`Preparing upload locally: ${done.toLocaleString()} / ${total.toLocaleString()} photos checked. Creating integrity checksums; no photos are being transferred yet.`;}else if(item.phase==='uploading'){progress.value=100*item.completedBytes/Math.max(1,item.totalBytes);const speed=item.bytesPerSecond>0?`${(item.bytesPerSecond/1024**2).toFixed(1)} MB/s`:'Estimating speed…';message=`Uploading to Viewer: ${done.toLocaleString()} / ${total.toLocaleString()} photos · ${(item.completedBytes/1024**2).toFixed(1)} / ${(item.totalBytes/1024**2).toFixed(1)} MB · ${speed}`;}else{progress.value=100;message='Upload received. Assembling and verifying your source photos on the server…';}say(message);}
  function providerOptions(){const selected=selectSubmissionProvider(currentProviders,node.value);node.innerHTML='<option value="">Choose available node</option>'+currentProviders.map(item=>{const availability=providerSubmissionState(item);return `<option value="${escape(item.id)}" ${availability.eligible?'':'disabled'}>${escape(item.displayName)} — ${escape(availability.label)}</option>`;}).join('');node.value=selected;providerNote();}
  const compatiblePreset=(preset,provider)=>Boolean(provider&&preset.enabled&&(!preset.providerType||preset.providerType===provider.type)&&(!preset.capabilityFingerprint||preset.capabilityFingerprint===provider.capabilityFingerprint));
  function providerNote(){const item=currentProviders.find(item=>item.id===node.value);form.querySelector('[data-provider-note]').textContent=item?providerSubmissionState(item).label:'No available node selected. Configure or refresh nodes under Providers & nodes.';const preset=form.elements.presetId,previous=preset.value,eligible=presets.filter(p=>compatiblePreset(p,item));preset.innerHTML='<option value="">Node defaults</option>'+eligible.map(p=>`<option value="${escape(p.id)}">${escape(p.displayName)}</option>`).join('');preset.value=eligible.some(p=>p.id===previous)?previous:'';syncTaskOptions();}
  function setBusy(value){busy=value;for(const element of form.querySelectorAll('input,select,button'))if(!element.closest('[data-task-options]'))element.disabled=value;taskOptions.setDisabled(value);progress.hidden=!value||presetSaving;const background=form.querySelector('[data-background]');if(background){background.disabled=false;background.hidden=!value||presetSaving;}if(value&&!presetSaving)view.addEventListener('beforeunload',leaveWarning);else view.removeEventListener('beforeunload',leaveWarning);updateTransfer();if(!value)providerOptions();}
  function resetSource(){clearPhotoPreview();datasetId='';prepared=null;sourceOperation=null;submissionFingerprint='';datasetKey=crypto.randomUUID();submissionId=crypto.randomUUID();copyKey=crypto.randomUUID();}
  function selectFiles(list){if(busy||!list?.length)return;resetSource();files=[...list];try{const info=inspectTaskPhotos(files);selection.textContent=`${info.items.length.toLocaleString()} ${info.items.length===1?'photo':'photos'} selected${info.ignored.length?`; ${info.ignored.length} unsupported files skipped`:''}${info.renamed.length?`; ${info.renamed.length} duplicate filenames will be renamed in the processing copy`:''}.`;say('');schedulePhotoPreview();}catch(error){files=[];selection.textContent='No valid selection.';say(error.message);}}
  async function browse(path='',offset=0){if(busy||signal.aborted||source!=='server')return;const generation=++browseGeneration,host=form.querySelector('[data-server-browser]'),usable=()=>!busy&&!signal.aborted&&source==='server'&&generation===browseGeneration;host.textContent='Loading folders…';try{const page=await api(`/api/v1/dataset-imports/browse?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`,{signal});if(signal.aborted||source!=='server'||generation!==browseGeneration)return;host.innerHTML=`<div class="row-actions">${path?'<button type="button" data-parent>Up one folder</button><button type="button" data-select-folder>Select this folder</button>':''}</div><p>${escape(page.path||'Import folder')}</p><div class="task-source-browser">${page.entries.map((item,index)=>`<div><label><input type="checkbox" data-pick="${index}" ${selectedPaths.has(item.relativePath)?'checked':''}>${escape(item.name)}</label>${item.kind==='folder'?`<button type="button" data-open="${index}">Open folder</button>`:''}</div>`).join('')||'<p>No photos or folders here.</p>'}</div>${page.nextOffset!=null?'<button type="button" data-next>Next page</button>':''}`;
      for(const control of host.querySelectorAll('button,input'))control.disabled=busy;
      const update=()=>{resetSource();selection.textContent=`${selectedPaths.size} server selections. Folders will be scanned recursively.`;schedulePhotoPreview();};
      host.querySelector('[data-parent]')?.addEventListener('click',()=>{if(usable())void browse(page.parentPath||'');});host.querySelector('[data-select-folder]')?.addEventListener('click',()=>{if(!usable())return;selectedPaths.add(page.path);update();void browse(page.path,offset);});host.querySelector('[data-next]')?.addEventListener('click',()=>{if(usable())void browse(page.path,page.nextOffset);});
      host.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>{if(usable())void browse(page.entries[Number(button.dataset.open)].relativePath);});host.querySelectorAll('[data-pick]').forEach(input=>input.onchange=()=>{const path=page.entries[Number(input.dataset.pick)].relativePath;if(!usable()){input.checked=selectedPaths.has(path);return;}if(input.checked)selectedPaths.add(path);else selectedPaths.delete(path);update();});
    }catch(error){if(!signal.aborted&&source==='server'&&generation===browseGeneration)host.textContent=error.message;}}
  async function waitOperation(operation){let item=operation;if(!item?.id)throw new Error('Source preparation did not return a background operation.');while(!['succeeded','complete','completed','failed','cancelled'].includes(item.status)){if(signal.aborted)throw new DOMException('Cancelled','AbortError');say(allowBackground?'Preparing source photos on the server. You can browse this workspace; keep this browser tab open until the task is submitted.':'Preparing your source photos. Closing stops task submission; accepted preparation remains in Background work.');await new Promise((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,1500),abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};signal.addEventListener('abort',abort,{once:true});});item=(await api(`/api/v1/operations/${encodeURIComponent(item.id)}`,{signal})).operation;if(!item?.id)throw new Error('Source preparation status is unavailable.');sourceOperation=item;}if(!['succeeded','complete','completed'].includes(item.status))throw new Error(item.errorMessage||item.error?.message||'Source preparation failed. Check Background work before retrying.');}
  form.querySelector('[data-files]').onchange=event=>selectFiles(event.target.files);form.querySelector('[data-folder]').onchange=event=>selectFiles(event.target.files);node.onchange=providerNote;
  form.elements.presetId.onchange=syncTaskOptions;
  form.querySelector('[data-edit-options]').onclick=()=>{const editor=form.querySelector('.task-options-editor');editor.open=!editor.open;if(editor.open)editor.scrollIntoView({block:'nearest'});};
  form.querySelector('[data-background]')?.addEventListener('click',()=>dialog.close());
  form.querySelector('[data-preset-open]')?.addEventListener('click',()=>{form.querySelector('[data-preset-save]').hidden=false;form.elements.newPresetName.focus();});
  form.querySelector('[data-preset-cancel]')?.addEventListener('click',()=>{form.querySelector('[data-preset-save]').hidden=true;});
  form.querySelector('[data-preset-save-button]')?.addEventListener('click',async()=>{
    if(busy||presetSaving||signal.aborted)return;const name=form.elements.newPresetName.value.trim(),note=form.querySelector('[data-preset-status]');
    if(!name){note.textContent='Enter a name for the new preset.';return;}if(!taskOptions.validate().valid){note.textContent='Check the processing options before saving.';return;}
    const provider=currentProviders.find(item=>item.id===node.value);if(!provider){note.textContent='Choose a processing node first.';return;}
    const options={...(presets.find(item=>item.id===form.elements.presetId.value)?.options||{}),...taskOptions.getOptions()};
    presetSaving=true;setBusy(true);note.textContent='Saving preset…';
    const body={displayName:name,providerId:provider.id,options,enabled:true},fingerprint=JSON.stringify(body);if(fingerprint!==presetRequestFingerprint){presetRequestFingerprint=fingerprint;presetRequestKey=crypto.randomUUID();}
    try{const result=await api('/api/v1/processing/presets',{method:'POST',headers:{'Idempotency-Key':presetRequestKey},body,signal});if(signal.aborted)return;if(!result?.preset?.id)throw new Error('The server did not return the saved preset.');presets=[...presets.filter(item=>item.id!==result.preset.id),result.preset];providerNote();form.elements.presetId.value=result.preset.id;syncTaskOptions();note.textContent='Preset saved and selected. You can still make one-time changes below.';}
    catch(error){if(!signal.aborted)note.textContent=error.message;}
    finally{presetSaving=false;if(!signal.aborted)setBusy(false);}
  });
  form.elements.existingDataset.onchange=()=>{resetSource();selection.textContent='Saved source selected.';};
  function openPicker(selector){if(busy)return;const input=form.querySelector(selector);input.value='';input.click();}
  function chooseSource(next){const changed=source!==next;source=next;if(changed){resetSource();files=[];selectedPaths.clear();selection.textContent='Select photos or a source folder.';}form.querySelectorAll('[data-source-panel]').forEach(panel=>panel.hidden=panel.dataset.sourcePanel!==source);form.querySelectorAll('[data-source]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.source===source)));}
  form.querySelector('[data-choose-folder]')?.addEventListener('click',()=>{if(busy)return;chooseSource('pc');openPicker('[data-folder]');});
  form.querySelectorAll('[data-source]').forEach(button=>button.onclick=()=>{if(busy)return;chooseSource(button.dataset.source);if(source==='server')void browse();else if(source==='pc')openPicker('[data-files]');});
  form.onsubmit=async event=>{event.preventDefault();if(busy)return;const name=form.elements.taskDisplayName.value.trim(),providerId=node.value;if(!name||!providerId)return say('Enter a task name and choose an available processing node.');
    if(source==='pc'&&!files.length||source==='server'&&!selectedPaths.size||source==='existing'&&!form.elements.existingDataset.value)return say('Select source photos first.');
    if(!taskOptions.validate().valid)return say('Check the highlighted processing options before starting.');
    let options;try{options=taskOptions.getOptions();}catch(error){return say(error.message);}
    const presetId=form.elements.presetId.value,capabilityFingerprint=currentProviders.find(item=>item.id===providerId)?.capabilityFingerprint;setBusy(true);try{currentProviders=(await api('/api/v1/processing/providers?limit=100',{signal})).providers||[];const provider=currentProviders.find(item=>item.id===providerId);if(!provider||!providerSubmissionState(provider).eligible)throw new Error('The selected node is not currently available. Refresh or choose another node.');if(provider.capabilityFingerprint!==capabilityFingerprint)throw new Error('The node options changed. Review the refreshed settings before starting.');if(presetId&&!presets.some(p=>p.id===presetId&&compatiblePreset(p,provider)))throw new Error('The selected preset no longer matches this node. Choose another preset.');
      if(source==='existing')datasetId=form.elements.existingDataset.value;
      else if(source==='pc'){const existing=datasetId?(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset:null;if(existing?.status!=='finalized'){if(sourceOperation)await waitOperation(sourceOperation);else{prepared??=await prepareTaskPhotos(files,{signal,onProgress:showProgress});if(!datasetId)datasetId=(await api('/api/v1/datasets',{method:'POST',headers:{'Idempotency-Key':datasetKey},body:{projectId:project.id,displayName:name},signal})).dataset.id;
        const result=await uploadTaskPhotos({datasetId,prepared,api,token,signal,onProgress:showProgress});sourceOperation=result.operation;await waitOperation(sourceOperation);}}
      }else {if(!datasetId){const result=await api('/api/v1/dataset-imports/copy',{method:'POST',headers:{'Idempotency-Key':copyKey},body:{projectId:project.id,displayName:name,paths:[...selectedPaths]},signal});datasetId=result.dataset.id;sourceOperation=result.operation;}const existing=(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset;if(existing?.status!=='finalized')await waitOperation(sourceOperation);}
      const dataset=(await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}`,{signal})).dataset;if(dataset?.status!=='finalized')throw new Error('Source is still preparing. Check Background work, then use this saved source when ready.');
      if(signal.aborted)return;
      currentProviders=(await api('/api/v1/processing/providers?limit=100',{signal})).providers||[];
      const finalProvider=currentProviders.find(item=>item.id===providerId);
      if(!finalProvider||!providerSubmissionState(finalProvider).eligible)throw new Error('The selected node is no longer available. Choose an available node before starting.');
      if(finalProvider.capabilityFingerprint!==capabilityFingerprint)throw new Error('The node options changed while preparing photos. Review the refreshed settings before starting.');
      if(signal.aborted)return;const fingerprint=JSON.stringify([datasetId,name,providerId,presetId,options]);if(submissionFingerprint&&submissionFingerprint!==fingerprint)submissionId=crypto.randomUUID();submissionFingerprint=fingerprint;
      say('Submitting processing task…');const result=await api('/api/v1/task-submissions',{method:'POST',headers:{'Idempotency-Key':submissionId},body:{submissionId,projectId:project.id,datasetId,taskDisplayName:name,providerId,...(presetId?{presetId}:{}),options},signal});if(!signal.aborted){completed=true;setBusy(false);dialog.close();dispose();await onComplete(result);}
    }catch(error){if(!signal.aborted)say(`${error.message}${datasetId?' Your source dataset is retained; no original files were removed.':''}`);}finally{if(!signal.aborted)setBusy(false);}};
  function dispose(){if(disposed)return;disposed=true;controller.abort();clearPhotoPreview();taskOptions.dispose();view.removeEventListener('beforeunload',leaveWarning);transferPanel?.remove();dialog.classList.remove('new-task-modal');dialog.removeEventListener('close',close);onDispose();}
  const close=()=>{if(allowBackground&&!completed&&!presetSaving&&(busy||transferPanel)){updateTransfer();return;}dispose();};dialog.addEventListener('close',close);providerOptions();
  void api('/api/v1/processing/providers?limit=100',{signal}).then(result=>{if(!signal.aborted&&!busy){currentProviders=result.providers||[];providerOptions();}}).catch(error=>{if(!signal.aborted&&!busy)say(`Could not refresh processing nodes: ${error.message}`);});
  if(!canUpload){source=canImport?'server':'existing';form.querySelectorAll('[data-source-panel]').forEach(panel=>panel.hidden=panel.dataset.sourcePanel!==source);if(source==='server')void browse();}
  form.querySelectorAll('[data-source]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.source===source)));
  return {dispose,reopen,get active(){return !disposed;}};
}
