// Injected only after the user starts a job on a supported tab.
(()=>{
if(globalThis.__shiju)return;
const delay=n=>new Promise(r=>setTimeout(r,n));
const key=()=>ShijuMetrics.workId();
function activeSlide(){
 const id=key();
 return id && /^\d+$/.test(id) && document.querySelector('[data-e2e="feed-active-video"][data-e2e-vid="'+id+'"]');
}
function visible(v){const r=v.getBoundingClientRect();return Math.max(0,Math.min(r.right,innerWidth)-Math.max(r.left,0))*Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0))}
function pick(){
 const root=activeSlide()||document;
 return [...root.querySelectorAll('video')].filter(v=>visible(v)>100&&v.readyState>=1).sort((a,b)=>visible(b)-visible(a)||Number(!b.paused)-Number(!a.paused))[0];
}
function complete(rows,d){
 rows=rows.filter(r=>r.t&&Number.isFinite(r.s)&&Number.isFinite(r.e)&&r.s>=0&&r.e>r.s&&r.s<d).sort((a,b)=>a.s-b.s);
 if(!rows.length||rows[0].s>Math.max(2,d*.08)||rows.at(-1).e<d-Math.min(4,d*.12)||rows.at(-1).e>d+3)return [];
 let edge=0,seen=0;for(const r of rows){if(r.s-edge>Math.max(6,d*.15))return [];seen+=Math.max(0,r.e-Math.max(edge,r.s));edge=Math.max(edge,r.e)}
 return seen/d>=.46?rows:[];
}
function tracks(v){return [...v.textTracks].filter(t=>['captions','subtitles'].includes(t.kind)).sort((a,b)=>Number(/^zh/i.test(b.language))-Number(/^zh/i.test(a.language)))}
async function readWorkItems(id, signal){
 if(!id)return [];
 // Only inspect data published in the document for the exact visible work.
 const queue=[];for(const el of document.querySelectorAll('script[type="application/json"],script#RENDER_DATA')){
  let raw=el.textContent.trim();if(raw.length>5000000)continue;
  try{if(raw.startsWith('%'))raw=decodeURIComponent(raw);queue.push(JSON.parse(raw))}catch{}
 }
 let item;for(let i=0;i<queue.length&&i<24000;i++){
  const x=queue[i];if(!x||typeof x!=='object')continue;
  if(String(x.aweme_id??x.awemeId??'')===id && x.video){item=x;break}
  queue.push(...Object.values(x).filter(v=>v&&typeof v==='object').slice(0,1000))
 }
 const items=item?[item]:[];
 const detail=performance.getEntriesByType('resource').map(e=>new URL(e.name,location.href)).reverse()
   .find(u=>u.origin===location.origin && u.pathname==='/aweme/v1/web/aweme/detail/' && u.searchParams.get('aweme_id')===id);
 const endpoint=new URL('/aweme/v1/web/aweme/detail/',location.origin);
 endpoint.search=new URLSearchParams({aid:'6383',device_platform:'webapp',aweme_id:id});
 for(const url of new Set([detail?.href,endpoint.href].filter(Boolean))){
   try{
     const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])});
     const remote=response.ok && (await response.json()).aweme_detail;
     if(String(remote?.aweme_id)===id && remote.video){items.unshift(remote);break}
   }catch{signal.throwIfAborted()}
 }
 return items;
}
async function subtitles(v,workItems){
 const ts=tracks(v),old=ts.map(t=>t.mode);
 try {
   ts.forEach(t=>{if(t.mode==='disabled')t.mode='hidden'});
   for(let i=0;i<(ts.length?9:0);i++){
     for(const t of ts){const rows=complete(Array.from(t.cues||[],c=>({s:c.startTime,e:c.endTime,t:(c.getCueAsHTML?.().textContent??c.text??'').trim()})),v.duration);if(rows.length)return rows}
     await delay(140)
   }
 }finally{ts.forEach((t,i)=>{t.mode=old[i]})}
 const items=await workItems();
 const infos=items.flatMap(item=>[item.video.subtitle_infos,item.video.subtitleInfos,item.video_subtitle?.list,item.videoSubtitle?.list,item.caption_infos].filter(Array.isArray).flat());
 for(const info of infos.slice(0,6)){
  try{
   let data=info;
   if(!data.utterances){
    const url=new URL(info.url||info.subtitle_url||info.url_list?.[0]||'',location.href);
    if(url.protocol!=='https:'||!/(^|\.)(douyin\.com|douyinvod\.com|bytecdn\.cn|byteimg\.com|amemv\.com|byteoversea\.com)$/.test(url.hostname)||url.href===location.href)continue;
    const r=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(1800)});if(!r.ok)continue;data=await r.json()
   }
   const rows=complete((data.utterances||[]).map(c=>({s:Number(c.start_time??c.startTime)/1000,e:Number(c.end_time??c.endTime)/1000,t:String(c.text??'').trim()})),v.duration);if(rows.length)return rows
  }catch{}
 }
 return [];
}
let j;
function cleanup(){
 j?.controller.abort();j=null;
}
globalThis.__shiju=async(op,token,force)=>{
 if(op==='probe'){
  cleanup();let v;for(let n=0;n<20&&!(v=pick());n++)await delay(150);
  if(!v)throw Error('没有找到可播放的视频。请在抖音网页版打开单条作品，确认能播放后再试。');
  if(!Number.isFinite(v.duration)||v.duration<=0)throw Error('请等待视频加载完成；直播无法从头转写。');
  const x=j={v,token,src:v.currentSrc,id:key(),duration:v.duration,controller:new AbortController()};
  x.workItems=()=>x.itemsPromise??=readWorkItems(x.id,x.controller.signal);
  const metricId=j.id;
  if(metricId)ShijuMetrics.read(metricId).then(values=>chrome.runtime.sendMessage({to:'bg',op:'workMetrics',workId:metricId,token,values})).catch(()=>{});
  const reuse=!!x.id && x.id===force.previousId && x.duration===force.previousDuration;
  const rows=force.skip||(reuse&&force.previousCaptions)?[]:await subtitles(v,x.workItems);
  if(j!==x||key()!==x.id||v.currentSrc!==x.src)throw Error('作品已切换，请重新提取。');
  return {duration:v.duration,title:activeSlide()?.querySelector('[data-e2e="video-desc"]')?.textContent?.trim()||document.title,rows,workId:j.id,reuse};
 }
 if(!j||token!==j.token)throw Error('视频页面已切换，请重新开始');
 const x=j,v=x.v;
 if(op==='release'){cleanup();return}
 if(!v.isConnected||v.currentSrc!==x.src||key()!==x.id)throw Error('作品已切换，请重新开始');
 if(op==='validate')return true;
 if(op==='videoBytes'){
  x.picture=await __shijuVideoBytes(v,await x.workItems(),force,x.controller.signal);
  return x.picture?.size||0;
 }
 if(op==='videoChunk'){
  const bytes=new Uint8Array(await x.picture.slice(force,force+384000).arrayBuffer());
  let data='';
  for(let i=0;i<bytes.length;i+=8192)data+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {size:bytes.length,data:btoa(data)};
 }
 if(op==='readTrack'){
  x.audio=await globalThis.__shijuReadTrack(v,await x.workItems(),x.controller.signal,force);
  if(j!==x || key()!==x.id || v.currentSrc!==x.src)throw Error('作品已切换');
  return x.audio.length;
 }
 if(op==='samples')return globalThis.__shijuSamples(x.audio,force);
};
})();
