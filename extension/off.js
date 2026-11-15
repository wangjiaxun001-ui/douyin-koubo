let fast=null;
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
 })().then(result=>reply(result||{ok:true}),e=>reply({error:e.message}));return true
});
