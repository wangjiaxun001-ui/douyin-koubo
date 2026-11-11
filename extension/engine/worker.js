let vad, recognizer, remainder = new Float32Array(0);
var Module = {
  locateFile: name => new URL(name, self.location.href).href,
  onAbort: reason => postMessage({error:String(reason)}),
  onRuntimeInitialized() {
    try {
      vad = createVad(Module);
      recognizer = new OfflineRecognizer({modelConfig:{tokens:'./tokens.txt',paraformer:{model:'./paraformer.onnx'},numThreads:1,debug:0}},Module);
      if (!vad.handle || !recognizer.handle) throw Error('模型初始化失败');
      postMessage({ready:true});
    } catch(e) {postMessage({error:String(e)})}
  }
};
importScripts('sherpa-onnx-asr.js','sherpa-onnx-vad.js','sherpa-onnx-wasm-main-vad-asr.js');
function drain(){
  while(!vad.isEmpty()){
    const seg=vad.front(); vad.pop();
    const st=recognizer.createStream();
    try {
      st.acceptWaveform(16000,seg.samples); recognizer.decode(st);
      const text=recognizer.getResult(st).text.trim();
      postMessage({row:{s:seg.start/16000,e:(seg.start+seg.samples.length)/16000,t:text || '〔此处未识别清楚〕'}});
    } finally {st.free()}
  }
}
onmessage=({data})=>{
 try {
   if(data.end){
     const last=new Float32Array(512); last.set(remainder); vad.acceptWaveform(last);
     // Supply endpoint silence as well as flushing the detector's current segment.
     for(let i=0;i<24;i++)vad.acceptWaveform(new Float32Array(512));
     vad.flush(); drain(); postMessage({done:true});return;
   }
   const buf = new Float32Array(remainder.length+data.length);
   buf.set(remainder); buf.set(data,remainder.length);
   let i=0; for(;i+512<=buf.length;i+=512){vad.acceptWaveform(buf.subarray(i,i+512));drain()}
   remainder=buf.slice(i); postMessage({ack:data.length});
 } catch(e){postMessage({error:String(e)})}
};
