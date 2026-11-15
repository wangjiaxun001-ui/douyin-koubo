let state=null, writes=Promise.resolve();
const init=chrome.storage.session.get('job').then(r=>{state=r.job||null});
const running=j=>j&&['probe','loading','fast','finishing'].includes(j.phase);
const valid=url=>{try{const u=new URL(url);return u.protocol==='https:'&&/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(u.hostname)}catch{return false}};
function save(){const snapshot=structuredClone(state);writes=writes.catch(()=>{}).then(()=>chrome.storage.session.set({job:snapshot}));return writes}
const page=async(j,op,force=false)=>{
 const [r]=await chrome.scripting.executeScript({target:{tabId:j.tab},func:async(a,b,c)=>{try{return {value:await globalThis.__shiju(a,b,c)}}catch(e){return {error:e.message}}},args:[op,j.token,force]});
 if(!r?.result||r.result.error)throw Error(r?.result?.error||'无法连接播放器');
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
function playerAddresses(id){
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
    const add=(list,size)=>{if(!(size>48*1024*1024)&&Array.isArray(list))for(const x of list){const src=typeof x==='string'?x:x?.src;if(typeof src==='string'&&src.length<16384&&!urls.includes(src))urls.push(src)}};
    if(Array.isArray(m.bitRateAudioList))for(const audio of m.bitRateAudioList)add(audio.urlList,audio.size);
    add(m.playAddr,m.playAddrSize);
    if(urls.length)return urls.slice(0,8);
   }
  }
 }
 return urls;
}
async function readAudio(j){
 const [result]=await chrome.scripting.executeScript({target:{tabId:j.tab},world:'MAIN',func:playerAddresses,args:[j.workId||'']}).catch(()=>[]);
 guard(j);
 return page(j,'readTrack',result?.result||[]);
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
  ? '整条音轨已转写。首段 '+secondsSinceStart(j.firstAt)+' 秒，整篇 '+secondsSinceStart(Date.now())+' 秒。'
  : '整条音轨未识别到清晰人声。';
 await end(j,j.rows.length?'done':'empty',result);
}
async function start(tab,force){
 if(running(state))throw Error('已有视频正在处理');
 const t=await chrome.tabs.get(tab);
 if(!valid(t.url))throw Error('请在 Chrome 中打开抖音分享链接，等作品页面出现后再点提取。');
 if(running(state))throw Error('已有视频正在处理');
 const previous=state;
 const reuse=!force&&previous?.phase==='done'&&previous.workId&&previous.rows?.some(r=>r.t&&r.t!=='〔此处未识别清楚〕');
 const j=state={token:crypto.randomUUID(),startedAt:Date.now(),tab,phase:'probe',message:'正在读取这条视频的字幕…',title:t.title||'抖音作品',duration:0,time:0,rows:[],source:''};await save();
 try{
  await chrome.scripting.executeScript({target:{tabId:tab},files:['metrics.js','fast.js','page.js']});guard(j);
  const p=await page(j,'probe',{skip:force,previousId:reuse?previous.workId:null,previousDuration:reuse?previous.duration:0});guard(j);Object.assign(j,{title:p.title,duration:p.duration,workId:p.workId});
  if(reuse&&p.reuse){
   Object.assign(j,{rows:previous.rows,source:previous.source,time:p.duration});
   if(!j.metricsAt)Object.assign(j,{metrics:previous.metrics,metricsAt:previous.metricsAt});
   await end(j,'done','已读取这条作品上次完成的逐字稿。');return
  }
  if(p.rows.length){j.rows=p.rows;j.source='网页字幕';j.time=p.duration;await end(j,'done','已提取网页字幕。可对照原声核对。');return}

  j.phase='loading';j.source='本地语音识别';j.message='未使用字幕，正在准备本地识别…';await save();
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'off.html',reasons:['WORKERS'],justification:'用本地识别模型处理当前作品的完整音轨'});
  guard(j);
  j.source='快速音轨转写';j.message='正在读取当前作品的音轨…';await save();
  await fastTranscribe(j);

 }catch(e){if(state===j&&running(j)&&j.phase!=='finishing'){await off(j,'abort').catch(()=>{});await end(j,j.rows.length?'partial':'error',e.message)}}
}
async function stop(j,why){
 if(!running(j)||j.phase==='finishing')return;
 j.phase='finishing';await save();
 await off(j,'abort').catch(()=>{});await end(j,'partial',why);
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m.to!=='bg')return;
 (async()=>{
  await init;
  if(m.op==='start'){await start(m.tab,!!m.force);return}
  const j=state;if(!j||j.token!==m.token)return;
  if(m.op==='workMetrics'&&s.tab?.id===j.tab&&/^\d+$/.test(m.workId)&&(!j.workId||j.workId===m.workId)){
   j.metrics=m.values;j.metricsAt=Date.now();j.workId=m.workId;await save();return;
  }
  if(!running(j))return;
  if(m.op==='stop')await stop(j,'手动停止');
 })().then(()=>reply({ok:true}),e=>reply({error:e.message}));return true
});
chrome.tabs.onRemoved.addListener(async id=>{await init;if(state?.tab===id)await stop(state,'视频标签页已关闭')});
chrome.tabs.onUpdated.addListener(async(id,c)=>{await init;if(state?.tab===id&&c.status==='loading')await stop(state,'视频页面已刷新或跳转')});
