class Tap extends AudioWorkletProcessor {
 constructor(){
   super();this.block=new Float32Array(2048);this.n=0;this.closed=false;
   this.port.onmessage=()=>{this.closed=true;if(this.n)this.port.postMessage(this.block.slice(0,this.n));this.port.postMessage('end')};
 }
 process(inputs){
   const c=inputs[0]?.[0];
   if(!this.closed && c)for(const sample of c){this.block[this.n++]=sample;if(this.n===2048){this.port.postMessage(this.block,[this.block.buffer]);this.block=new Float32Array(2048);this.n=0}}
   return !this.closed;
 }
}
registerProcessor('koubo-tap',Tap);
