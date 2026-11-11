// Injected only after the user starts a job on a supported tab.
(()=>{
if(globalThis.__shiju)return;
const delay=n=>new Promise(r=>setTimeout(r,n));
const key=()=>new URL(location.href).searchParams.get('modal_id')||location.pathname.match(/(?:video|note)\/(\d+)/)?.[1]||'';
function visible(v){const r=v.getBoundingClientRect();return Math.max(0,Math.min(r.right,innerWidth)-Math.max(r.left,0))*Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0))}
function pick(){return [...document.querySelectorAll('video')].filter(v=>visible(v)>100&&v.readyState>=1).sort((a,b)=>Number(!b.paused)-Number(!a.paused)||visible(b)-visible(a))[0]}
function complete(rows,d){
 rows=rows.filter(r=>r.t&&Number.isFinite(r.s)&&Number.isFinite(r.e)&&r.s>=0&&r.e>r.s&&r.s<d).sort((a,b)=>a.s-b.s);
 if(!rows.length||rows[0].s>Math.max(2,d*.08)||rows.at(-1).e<d-Math.min(4,d*.12)||rows.at(-1).e>d+3)return [];
 let edge=0,seen=0;for(const r of rows){if(r.s-edge>Math.max(6,d*.15))return [];seen+=Math.max(0,r.e-Math.max(edge,r.s));edge=Math.max(edge,r.e)}
 return seen/d>=.46?rows:[];
}
function tracks(v){return [...v.textTracks].filter(t=>['captions','subtitles'].includes(t.kind)).sort((a,b)=>Number(/^zh/i.test(b.language))-Number(/^zh/i.test(a.language)))}
async function subtitles(v){
 const ts=tracks(v),old=ts.map(t=>t.mode);
 try {
   ts.forEach(t=>{if(t.mode==='disabled')t.mode='hidden'});
   for(let i=0;i<(ts.length?9:0);i++){
     for(const t of ts){const rows=complete(Array.from(t.cues||[],c=>({s:c.startTime,e:c.endTime,t:(c.getCueAsHTML?.().textContent??c.text??'').trim()})),v.duration);if(rows.length)return rows}
     await delay(140)
   }
 }finally{ts.forEach((t,i)=>{t.mode=old[i]})}
 const id=key();if(!id)return [];
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
 if(!item)return [];
 const infos=[item.video.subtitle_infos,item.video.subtitleInfos,item.video_subtitle?.list,item.videoSubtitle?.list,item.caption_infos].filter(Array.isArray).flat();
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
 if(!j)return;const x=j;j=null;clearInterval(x.timer);x.events?.abort();
 if(x.changed){x.v.loop=x.loop;x.v.muted=x.muted;x.v.volume=x.volume;x.v.playbackRate=x.rate}
}
function send(op,extra={}){if(j)chrome.runtime.sendMessage({to:'bg',op,token:j.token,...extra}).catch(()=>{})}
globalThis.__shiju=async(op,token,force)=>{
 if(op==='probe'){
  cleanup();let v;for(let n=0;n<20&&!(v=pick());n++)await delay(150);
  if(!v)throw Error('没有找到可播放的视频。请在抖音网页版打开单条作品，确认能播放后再试。');
  if(!Number.isFinite(v.duration)||v.duration<=0)throw Error('请等待视频加载完成；直播无法从头转写。');
  j={v,token,src:v.currentSrc,id:key(),duration:v.duration};
  const rows=force?[]:await subtitles(v);
  return {duration:v.duration,title:document.title,rows};
 }
 if(!j||token!==j.token)throw Error('视频页面已切换，请重新开始');
 const x=j,v=x.v;
 if(op==='release'){cleanup();return}
 if(!v.isConnected||v.currentSrc!==x.src||key()!==x.id)throw Error('作品已切换，请重新开始');
 if(op==='rewind'){
  Object.assign(x,{changed:true,loop:v.loop,muted:v.muted,volume:v.volume,rate:v.playbackRate});
  v.pause();v.loop=false;v.playbackRate=1;v.currentTime=0;
  for(let i=0;i<50&&(v.seeking||v.currentTime>.15);i++)await delay(70);
  if(v.seeking||v.currentTime>.15)throw Error('播放器不允许回到开头，无法取得全段');
  v.muted=false;if(v.volume===0)v.volume=1;return
 }
 if(op==='play'){
  if(v.currentTime>.2)throw Error('播放器未停在开头，请重试');
  const ac=x.events=new AbortController();
  const finish=(ok,why)=>{if(!x.ending){x.ending=true;clearInterval(x.timer);send('finish',{ok,why,time:Math.min(v.currentTime,x.duration)})}};
  const on=(t,f)=>v.addEventListener(t,f,{signal:ac.signal});
  on('ended',()=>finish(true,''));on('seeking',()=>finish(false,'进度被拖动'));on('emptied',()=>finish(false,'视频源已切换'));
  on('ratechange',()=>{if(v.playbackRate!==1)finish(false,'播放速度已更改')});
  on('volumechange',()=>{if(v.muted||!v.volume)finish(false,'播放器已静音')});
  on('error',()=>finish(false,'视频播放失败'));
  await Promise.race([v.play(),delay(6000).then(()=>{if(v.paused)throw Error('请先在网页上点一次播放，再重试')})]);
  let last=-1,stamp=Date.now();
  x.timer=setInterval(()=>{
    if(x.ending)return;
    if(x.src!==v.currentSrc||!v.isConnected||key()!==x.id){finish(false,'已切换到其他作品');return}
    if(v.ended){finish(true,'');return}
    if(v.paused||v.currentTime===last){if(Date.now()-stamp>2500)finish(false,'播放暂停或缓冲时间过长');return}
    stamp=Date.now();last=v.currentTime;send('progress',{time:last})
  },800)
 }
};
})();
