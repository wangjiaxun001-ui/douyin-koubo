let state=null, writes=Promise.resolve();
const init=chrome.storage.session.get('job').then(r=>{state=r.job||null});
const running=j=>j&&['probe','loading','listening','fast','finishing'].includes(j.phase);
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
async function fastTranscribe(j){
 const [length]=await Promise.all([page(j,'readTrack'),off(j,'fastBoot')]);
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
async function start(tab,force,listen){
 if(running(state))throw Error('已有视频正在处理');
 const t=await chrome.tabs.get(tab);
 if(!valid(t.url))throw Error('请在 Chrome 中打开抖音分享链接，等作品页面出现后再点提取。');
 if(running(state))throw Error('已有视频正在处理');
 const j=state={token:crypto.randomUUID(),startedAt:Date.now(),tab,phase:'probe',message:'正在读取这条视频的字幕…',title:t.title||'抖音作品',duration:0,time:0,rows:[],source:''};await save();
 try{
  await chrome.scripting.executeScript({target:{tabId:tab},files:['metrics.js','fast.js','page.js']});guard(j);
  const p=await page(j,'probe',force||listen);guard(j);Object.assign(j,{title:p.title,duration:p.duration,workId:p.workId});
  if(p.rows.length){j.rows=p.rows;j.source='网页字幕';j.time=p.duration;await end(j,'done','已提取网页字幕。可对照原声核对。');return}

  j.phase='loading';j.source='本地语音识别';j.message='未使用字幕，正在准备本地识别…';await save();
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length)await chrome.offscreen.createDocument({url:'off.html',reasons:['USER_MEDIA'],justification:'只在用户点提取时，分段识别当前标签页的声音'});
  guard(j);
  if(!listen){
   j.source='快速音轨转写';j.message='正在读取当前作品的音轨…';await save();
   try{await fastTranscribe(j)}
   catch(e){
    guard(j);await off(j,'abort').catch(()=>{});guard(j);j.retryListen=true;
    await end(j,j.rows.length?'partial':'unavailable',e.message+'。可改用从头播放听写。');
   }
   return;
  }
  if(t.mutedInfo?.muted)throw Error('请先取消标签页静音，再开始播放听写。');
  await page(j,'rewind');guard(j);
  const id=await chrome.tabCapture.getMediaStreamId({targetTabId:tab});
  guard(j);await off(j,'boot',{id});guard(j);await off(j,'arm');guard(j);
  j.phase='listening';j.message='正在从头听写，可以收起插件。请让视频继续播放。';await save();guard(j);await page(j,'play')
 }catch(e){if(state===j&&running(j)&&j.phase!=='finishing'){await off(j,'abort').catch(()=>{});await end(j,j.rows.length?'partial':'error',e.message)}}
}
async function finish(j,ok,why){
 if(!running(j)||j.phase==='finishing')return;
 const active=j.phase==='listening';j.phase='finishing';j.complete=ok;j.reason=why||'';j.message='正在整理最后一段…';await save();
 if(!active){await off(j,'abort').catch(()=>{});await end(j,'partial',why||'已停止');return}
 try{await off(j,'finish')}catch{await end(j,'partial','音频已断开；仅保留已识别部分')}
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m.to!=='bg')return;
 (async()=>{
  await init;
  if(m.op==='start'){await start(m.tab,!!m.force,!!m.listen);return}
  const j=state;if(!j||j.token!==m.token)return;
  if(m.op==='workMetrics'&&s.tab?.id===j.tab&&/^\d+$/.test(m.workId)&&(!j.workId||j.workId===m.workId)){
   j.metrics=m.values;j.metricsAt=Date.now();j.workId=m.workId;await save();return;
  }
  if(!running(j))return;
  if(m.op==='stop'){await finish(j,false,'手动停止');return}
  if(m.op==='audio'&&s.url===chrome.runtime.getURL('off.html')){
   if(m.row){const r=m.row;r.s=Math.max(0,Math.min(j.duration,r.s));r.e=Math.max(r.s,Math.min(j.duration,r.e));j.rows.push(r);await save()}
   if(m.error)await end(j,j.rows.length?'partial':'error',m.error);
   if(m.done){const ok=j.phase==='finishing'&&j.complete;if(ok)j.time=j.duration;
    await end(j,ok?(j.rows.length?'done':'empty'):'partial',ok?(j.rows.length?'全段播放完毕。机器听写可能有错漏，请核对人名、数字。':'全段未识别到清晰人声。'):(j.reason||'已中断')+'；仅保留已听到的部分。')}
  }
  if(s.tab?.id!==j.tab)return;
  if(m.op==='progress'&&j.phase==='listening'){j.time=m.time;await save()}
  if(m.op==='finish'){j.time=m.time;await finish(j,m.ok,m.why)}
 })().then(()=>reply({ok:true}),e=>reply({error:e.message}));return true
});
chrome.tabs.onRemoved.addListener(async id=>{await init;if(state?.tab===id)await finish(state,false,'视频标签页已关闭')});
chrome.tabs.onUpdated.addListener(async(id,c)=>{await init;if(state?.tab===id&&c.status==='loading')await finish(state,false,'视频页面已刷新或跳转')});
