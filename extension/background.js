importScripts('precision.js');
let state=null, writes=Promise.resolve();
const init=chrome.storage.session.get('job').then(async r=>{
 state=r.job||null;
 if(running(state)){
  state.phase=state.rows?.length?'partial':'error';
  state.message='浏览器中断了上次提取，可以重新提取。';
  state.endedAt=Date.now();await save();
 }
});
const running=j=>j&&['probe','loading','fast','finishing'].includes(j.phase);
const valid=url=>{try{const u=new URL(url);return u.protocol==='https:'&&/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(u.hostname)}catch{return false}};
function save(){const snapshot=structuredClone(state);writes=writes.catch(()=>{}).then(()=>chrome.storage.session.set({job:snapshot}));return writes}
const page=async(j,op,force=false)=>{
 const [r]=await chrome.scripting.executeScript({target:{tabId:j.tab},func:async(a,b,c)=>{try{return {value:await globalThis.__shiju(a,b,c)}}catch(e){return {error:e.message,code:e.code}}},args:[op,j.token,force]});
 if(!r?.result||r.result.error)throw Object.assign(Error(r?.result?.error||'无法连接播放器'),{code:r?.result?.code});
 return r.result.value
};
async function off(j,op,extra={}){const r=await chrome.runtime.sendMessage({to:'off',op,token:j.token,...extra});if(!r||r.error)throw Error(r?.error||'声音处理器未响应');return r}
async function release(j){await page(j,'release').catch(()=>{})}
function guard(j){if(state!==j||!running(j)||j.phase==='finishing')throw Error('已停止')}
async function end(j,phase,message){
 if(state!==j||!running(j))return;
 j.phase=phase;j.message=message;j.endedAt=Date.now();await save();await release(j);

}
// The player exposes its normalized work on a component above the video. Read only
// addresses of that exact work; adjacent feed items must never supply the audio.
function playerAddresses(id, videoOnly){
 if(!/^\d+$/.test(id||''))return [];
 const seen=new Set(),urls=[];
 for(const video of document.querySelectorAll('video')){
  for(let el=video,depth=0;el&&depth<32;el=el.parentElement,depth++){
   const key=Object.keys(el).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
   for(let f=el[key],n=0;f&&n<64&&!seen.has(f);f=f.return,n++){
    seen.add(f);
    const item=f.memoizedProps?.awemeInfo;
    if(String(item?.awemeId)!==id||!item.video)continue;
    const m=item.video;
    const add=(list,size)=>{if(Array.isArray(list))for(const x of list){const src=typeof x==='string'?x:x?.src;if(typeof src==='string'&&src.length<16384&&!urls.includes(src))urls.push(src)}};
    if(!videoOnly && Array.isArray(m.bitRateAudioList))for(const audio of m.bitRateAudioList)add(audio.urlList,audio.size);
    add(m.playAddr,m.playAddrSize);
    if(urls.length)return urls.slice(0,8);
   }
  }
 }
 return urls;
}
function workIdFromUrl(value){
 try{const u=new URL(value);return u.searchParams.get('modal_id')||u.pathname.match(/\/video\/(\d+)/)?.[1]||''}catch{return ''}
}
// Search overlays can expose only a blob URL. The same work's standalone page
// exposes its complete media source. Recover in the user-authorized tab once;
// never infer the work from nearby players or resource history.
async function openIndependentWork(j){
 guard(j);
 const current=await chrome.tabs.get(j.tab);
 guard(j);
 if(!/^\d+$/.test(j.workId||'')||!valid(current.url)||workIdFromUrl(current.url)!==j.workId)throw Error('作品已切换，请重新提取。');
 const url=new URL(current.url);
 if(url.pathname==='/video/'+j.workId&&!url.searchParams.has('modal_id'))return false;
 // Keep the same origin, so this uses the existing activeTab grant.
 const target=url.origin+'/video/'+j.workId;
 j.recoveryUrl=target;
 j.message='搜索弹窗未提供完整媒体，正在打开这条作品的独立页面继续提取…';await save();
 try{
  await chrome.tabs.update(j.tab,{url:target});
  let loaded=false;
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
   guard(j);
   const tab=await chrome.tabs.get(j.tab);
   if(tab.url!==target&&tab.pendingUrl!==target)throw Error('作品已切换，请重新提取。');
   if(tab.url===target&&tab.status==='complete'){loaded=true;break}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  guard(j);
  if(!loaded)throw Error('独立作品页加载超时。请等待视频出现后再点提取。');
  await chrome.scripting.executeScript({target:{tabId:j.tab},files:['metrics.js','fast.js','page.js']});
  guard(j);
  const p=await page(j,'probe',{skip:true});
  guard(j);
  if(p.workId!==j.workId||Math.abs(p.duration-j.duration)>1)throw Error('独立页面的作品或时长不一致，已停止提取。');
  j.duration=p.duration;
  j.message='已打开同一条作品，正在读取完整媒体…';await save();
  return true;
 }finally{delete j.recoveryUrl}
}
async function readAudioOnce(j){
 const [result]=await chrome.scripting.executeScript({target:{tabId:j.tab},world:'MAIN',func:playerAddresses,args:[j.workId||'']}).catch(()=>[]);
 guard(j);
 return page(j,'readTrack',result?.result||[]);
}
async function readAudio(j){
 try{return await readAudioOnce(j)}catch(error){
  guard(j);
  if(error.code!=='NO_MEDIA_URL'||!await openIndependentWork(j))throw error;
  return readAudioOnce(j);
 }
}
async function fastTranscribe(j){
 const [length]=await Promise.all([readAudio(j),off(j,'fastBoot')]);
 guard(j);
 j.phase='fast';j.message='正在本机快速转写，可以收起插件。';await save();
 async function recognize(pcm, endOffset){
  const {rows}=await off(j,'fastChunk',{pcm});guard(j);
  if(rows.length && !j.firstAt)j.firstAt=Date.now();
  j.rows.push(...rows.map(r=>({...r,s:Math.min(j.duration,r.s),e:Math.min(j.duration,r.e)})));
  j.time=Math.min(endOffset/16000,j.duration);
  await save();
 }
 let offset=0;
 let part=await page(j,'samples',0);
 while(offset<length){
  guard(j);
  if(!Number.isInteger(part?.count)||part.count<=0||part.count>length-offset)throw Error('音轨已中断');
  offset+=part.count;
  // Only prefetch one chunk. The recognizer consumes samples in their original order.
  const [,next]=await Promise.all([
   recognize(part.pcm,offset),
   offset<length?page(j,'samples',offset):null
  ]);
  part=next;
 }
 guard(j);
 await recognize(null,length);guard(j);
 await off(j,'abort');guard(j);j.time=j.duration;
 const secondsSinceStart=t=>((t-j.startedAt)/1000).toFixed(1);
 const result=j.rows.length
  ? (j.mode==='precise'?'本机精校未就绪，已使用快速识别。':'')+'整条音轨已转写。首段 '+secondsSinceStart(j.firstAt)+' 秒，整篇 '+secondsSinceStart(Date.now())+' 秒。'
  : '整条音轨未识别到清晰人声。';
 j.captionNote=(j.mode==='precise'?'本机精校未连接，已改用快速识别。':'')+'当前文字来自音频听写，未与视频画面字幕核实，人名和品牌名可能听错。';
 await end(j,j.rows.length?'done':'empty',result);
}
async function start(tab,force,mode,terms,accepted,fresh=false){
 if(running(state))throw Error('已有视频正在处理');
 const t=await chrome.tabs.get(tab);
 if(!valid(t.url))throw Error('请在 Chrome 中打开抖音分享链接，等作品页面出现后再点提取。');
 if(running(state))throw Error('已有视频正在处理');
 if(mode==='picture')force=false;
 const hasNative=mode!=='fast' && await chrome.permissions.contains({permissions:['nativeMessaging']});
 if(running(state))throw Error('已有视频正在处理');
 const previous=state;
 const matchingMode=!previous?.forceVoice && previous?.mode===mode && (mode!=='picture'||previous.extractorRevision===4) && (previous.terms||'')===terms &&
   (!hasNative||['原声精校','画面字幕'].includes(previous.source));
 const reuse=!fresh&&!force&&previous?.phase==='done'&&((mode!=='picture'&&previous.source==='网页字幕')||matchingMode)&&previous.workId&&previous.rows?.some(r=>r.t&&r.t!=='〔此处未识别清楚〕');
 const j=state={token:crypto.randomUUID(),startedAt:Date.now(),tab,mode,terms,extractorRevision:4,forceVoice:force,phase:'probe',message:'正在读取这条视频的字幕…',title:t.title||'抖音作品',duration:0,time:0,rows:[],source:''};await save();accepted();
 try{
  await chrome.scripting.executeScript({target:{tabId:tab},files:['metrics.js','fast.js','page.js']});guard(j);
  const p=await page(j,'probe',{skip:mode==='picture'||force,previousCaptions:previous?.source==='网页字幕',previousId:reuse?previous.workId:null,previousDuration:reuse?previous.duration:0});guard(j);Object.assign(j,{title:p.title,duration:p.duration,workId:p.workId});
  if(reuse&&p.reuse&&!p.rows.length){
   Object.assign(j,{rows:previous.rows,source:previous.source,time:p.duration,review:previous.review,...(typeof previous.editedText==='string'?{editedText:previous.editedText,editRevision:previous.editRevision||0}:{}),captionNote:previous.captionNote||'这是上次的提取结果。发现错字可点「重新提取」，重新读取本条作品。'});
   if(!j.metricsAt)Object.assign(j,{metrics:previous.metrics,metricsAt:previous.metricsAt});
   await end(j,'done','已读取这条作品上次完成的逐字稿。');return
  }
  if(mode!=='picture'&&p.rows.length){j.rows=p.rows;j.source='网页字幕';j.time=p.duration;await end(j,'done','已提取网页字幕。可对照原声核对。');return}

  if(mode==='picture'){
   j.phase='loading';await save();await extractPictureOnly(j);return;
  }
  j.phase='loading';j.source='本地语音识别';j.message='未使用字幕，正在准备本地识别…';await save();
  if(await tryPrecision(j))return;
  guard(j);
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'off.html',reasons:['WORKERS'],justification:'用本地识别模型处理当前作品的完整音轨'});
  guard(j);
  j.source='快速音轨转写';j.message='正在读取当前作品的音轨…';await save();
  await fastTranscribe(j);

 }catch(e){if(state===j&&running(j)&&j.phase!=='finishing'){await off(j,'abort').catch(()=>{});await end(j,j.rows.length?'partial':'error',e.message)}}
}
async function stop(j,why){
 if(!running(j)||j.phase==='finishing')return;
 j.phase='finishing';precisionSessions.get(j.token)?.close();await save();
 await off(j,'abort').catch(()=>{});await end(j,'partial',why);
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m.to!=='bg')return;
 if(m.op==='start'){
  let acknowledged=false;
  init.then(()=>start(m.tab,!!m.force,['fast','precise'].includes(m.mode)?m.mode:'picture',String(m.terms||'').trim().slice(0,180),()=>{
   acknowledged=true;reply({ok:true});
  },!!m.fresh)).catch(error=>{if(!acknowledged)reply({error:error.message})});
  return true;
 }
 (async()=>{
  await init;
  const j=state;
  if(m.op==='editTranscript'){
   if(!j||j.token!==m.token)throw Error('已切换到另一篇逐字稿，请先复制保留当前修改。');
   if(running(j))throw Error('提取完成后才能编辑逐字稿。');
   if(typeof m.text!=='string'||m.text.length>200000)throw Error('逐字稿内容无效或超过20万字。');
   j.editedText=m.text;j.editedAt=Date.now();j.editRevision=(j.editRevision||0)+1;
   const revision=j.editRevision;await save();return {revision};
  }
  if(!j||j.token!==m.token)return;
  if(m.op==='audioProgress' && s.tab?.id===j.tab && j.phase==='loading'){
   const mb=Number.isFinite(m.bytes)?Math.max(0,m.bytes)/1024/1024:0;
   j.message=m.stage==='picture'?'正在读取原视频画面… '+mb.toFixed(1)+' MB':m.stage==='decode'?'完整媒体已读取，正在解码音轨…':'正在读取完整音轨… '+mb.toFixed(1)+' MB';
   await save();return;
  }
  if(m.op==='workMetrics'&&s.tab?.id===j.tab&&/^\d+$/.test(m.workId)&&(!j.workId||j.workId===m.workId)){
   j.metrics=m.values;j.metricsAt=Date.now();j.workId=m.workId;await save();return;
  }
  if(!running(j))return;
  if(m.op==='stop')await stop(j,'手动停止');
 })().then(result=>reply({ok:true,...result}),e=>reply({error:e.message}));return true
});
chrome.tabs.onRemoved.addListener(async id=>{await init;if(state?.tab===id)await stop(state,'视频标签页已关闭')});
chrome.tabs.onUpdated.addListener(async(id,c,tab)=>{
 await init;
 if(state?.tab!==id)return;
 const target=state.recoveryUrl;
 if(target&&(tab?.url===target||tab?.pendingUrl===target)&&(!c.url||c.url===target))return;
 if(c.status==='loading'||(target&&c.url))await stop(state,'视频页面已刷新或跳转');
});
