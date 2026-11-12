// Keep the original extraction workspace, including its bound Douyin tab.
globalThis.ShijuNav=(()=>{
 const home=()=>chrome.runtime.getURL('popup.html');
 const sourceUrl=u=>{try{return /^(?:[^.]+\.)*(?:douyin|iesdouyin)\.com$/.test(new URL(u).hostname)&&new URL(u).protocol==='https:'}catch{return false}};
 async function remember(){
  const tab=await chrome.tabs.getCurrent();
  if(tab?.id)await chrome.storage.session.set({extractReturn:{id:tab.id,url:location.href.split('#')[0]}});
 }
 async function back(){
  const {extractReturn:r,job}=await chrome.storage.session.get(['extractReturn','job']);
  const ctx=await chrome.runtime.getContexts({contextTypes:['TAB']});
  const targets=ctx.filter(t=>t.tabId>=0&&t.documentUrl?.startsWith(home()+'?workTab='));
  const chosen=targets.find(t=>t.tabId===r?.id&&t.documentUrl.split('#')[0]===r.url);
  const focus=async t=>{await chrome.tabs.update(t.tabId,{active:true});await chrome.windows.update(t.windowId,{focused:true})};
  if(chosen){await focus(chosen);return}
  const hasSource=async id=>/^\d+$/.test(String(id))&&sourceUrl((await chrome.tabs.get(Number(id)).catch(()=>null))?.url);
  let id=r?.url?.startsWith(home()+'?')?new URL(r.url).searchParams.get('workTab'):null;
  if(!await hasSource(id))id=await hasSource(job?.tab)?job.tab:null;
  for(const t of targets){const bound=new URL(t.documentUrl).searchParams.get('workTab');
   if(id?String(id)===bound:await hasSource(bound)){await focus(t);return}}
  const idle=targets.find(t=>new URL(t.documentUrl).searchParams.get('workTab')==='none');
  if(!id&&idle){await focus(idle);return}
  await chrome.tabs.create({url:home()+'?workTab='+(id||'none')});
 }
 return {remember,back,sourceUrl};
})();
