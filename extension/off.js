let job=null, fast=null;
const emit=(j,msg)=>chrome.runtime.sendMessage({to:'bg',op:'audio',token:j.token,...msg}).catch(()=>{});
function release(j){
  if(job===j)job=null;
  clearTimeout(j.timeout);j.worker?.terminate();
  j.stream?.getTracks().forEach(t=>t.stop());j.ctx?.close().catch(()=>{});
}
function fail(j,why){if(job!==j)return; j.reject?.(Error(why)); release(j); emit(j,{error:why})}
async function boot(m){
 if(job)release(job);
 const j=job={token:m.token,pending:0,accept:false,closing:false};
 try{
   const stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.id}}});
   if(job!==j){stream.getTracks().forEach(t=>t.stop());throw Error('已取消')}
   j.stream=stream; stream.getAudioTracks()[0].onended=()=>{if(!j.closing)fail(j,'标签页声音已断开')};
   j.ctx=new AudioContext({sampleRate:16000});
   await j.ctx.audioWorklet.addModule('tap.js');
   const src=j.ctx.createMediaStreamSource(stream);src.connect(j.ctx.destination);
   j.tap=new AudioWorkletNode(j.ctx,'koubo-tap',{channelCount:1,channelCountMode:'explicit'});src.connect(j.tap);j.tap.connect(j.ctx.destination);
   j.worker=new Worker('engine/worker.js');
   j.tap.port.onmessage=({data})=>{
     if(job!==j)return;
     if(data==='end'){j.worker.postMessage({end:true});return}
     if(!j.accept)return;
     j.pending+=data.length;
     if(j.pending>16000*35){fail(j,'本机识别跟不上播放速度，已保留前段');return}
     j.worker.postMessage(data,[data.buffer]);
   };
   await j.ctx.resume();
   await new Promise((resolve,reject)=>{
     j.reject=reject;j.timeout=setTimeout(()=>fail(j,'本地模型未能及时启动'),45000);
     j.worker.onerror=e=>fail(j,e.message||'识别引擎启动失败');
     j.worker.onmessage=({data})=>{
       if(job!==j)return;
       if(data.ready){clearTimeout(j.timeout);j.reject=null;resolve()}
       if(data.error)fail(j,data.error);
       if(data.ack)j.pending-=data.ack;
       if(data.row)emit(j,{row:data.row});
       if(data.done){release(j);emit(j,{done:true})}
     }
   });
 }catch(e){if(job===j)release(j);throw e}
}
chrome.runtime.onMessage.addListener((m,_,reply)=>{
 if(m.to!=='off')return;
 (async()=>{
   if(m.op==='fastBoot'){
     fast?.close(); fast=createFastWorker(m.token); await fast.ready; return;
   }
   if(fast?.token===m.token){
     if(m.op==='fastChunk')return {rows:await fast.process(m.pcm)};
     if(m.op==='abort'){fast.close();fast=null;return}
   }
   if(m.op==='boot')return boot(m);
   const j=job;if(!j||m.token!==j.token)return;
   if(m.op==='arm')j.accept=true;
   if(m.op==='abort'){j.reject?.(Error('已取消'));release(j)}
   if(m.op==='finish'&&!j.closing){
     j.closing=true; // Let the tab capture pipeline deliver its final samples.
     await new Promise(r=>setTimeout(r,280));
     j.tap.port.postMessage('end'); j.timeout=setTimeout(()=>fail(j,'识别尾段超时'),30000);
   }
 })().then(result=>reply(result||{ok:true}),e=>reply({error:e.message}));return true
});
