// Public viewers start with defaults and keep changes in memory only. Signed-in
// viewers use their explicit tab bearer; no browser-wide identity is assumed.
export function createViewerPreferences({token, fetcher=fetch, apply, notice=()=>{}}) {
  let state={mouseProfile:'default',sidebarCollapsed:false}, revision=0, persistent=false, queue=Promise.resolve();
  const request=async(method,body)=>{
    const bearer=token();
    if(!bearer)throw new Error('Signed-in preferences unavailable');
    const response=await fetcher('/api/v1/viewer-preferences',{method,cache:'no-store',credentials:'omit',headers:{Authorization:`Bearer ${bearer}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok)throw new Error('Preferences could not be saved to your account. Your current view is unchanged.');
    return (await response.json()).preferences;
  };
  return {
    async load(){
      const before=revision;
      try{
        const saved=await request('GET');persistent=true;
        if(revision===before){state={mouseProfile:['default','alternate'].includes(saved.mouseProfile)?saved.mouseProfile:'default',sidebarCollapsed:typeof saved.sidebarCollapsed==='boolean'?saved.sidebarCollapsed:state.sidebarCollapsed};apply({...state});}
        else {await this.change({});return;} // Save a choice made while the initial read was pending.
        notice('Preferences saved to your signed-in account.');
      }catch{persistent=false;notice('Changes apply to this page only.');}
    },
    change(patch,{save=true}={}){
      state={...state,...patch};revision++;apply({...state});
      if(!persistent||!save)return queue;
      const snapshot={...state};
      queue=queue.then(()=>request('PUT',snapshot)).then(()=>notice('Preferences saved to your signed-in account.'),()=>notice('Account save unavailable; changes apply to this page only.'));
      return queue;
    },
    snapshot:()=>({...state}),
  };
}
