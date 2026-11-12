// One chunk in flight at a time, so ASR speed determines the rate of reading audio.
function createFastWorker(token) {
  const worker = new Worker('engine/worker.js');
  let resolve, reject, timer, rows = [];
  function wait() {
    return new Promise((yes, no) => {
      resolve = yes; reject = no;
      timer = setTimeout(() => reject(Error('音轨识别超时')), 45000);
    });
  }
  const ready = wait();
  worker.onerror = e => { clearTimeout(timer); reject(Error(e.message || '识别引擎失败')); };
  worker.onmessage = ({data}) => {
    if (data.row) { rows.push(data.row); return; }
    clearTimeout(timer);
    if (data.error) reject(Error(data.error));
    else if (data.ready || data.ack || data.done) { resolve(rows); rows = []; }
  };
  return { token, ready,
    async process(pcm) {
      const result = wait();
      if (pcm) {
        const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(pcm) : Uint8Array.from(atob(pcm), c => c.charCodeAt(0));
        const quantized = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const samples = new Float32Array(quantized.length);
        for (let i = 0; i < samples.length; i++) samples[i] = quantized[i] / 32767;
        worker.postMessage(samples, [samples.buffer]);
      } else worker.postMessage({end:true});
      return result;
    },
    close() { clearTimeout(timer); reject(Error('已停止')); worker.terminate(); }
  };
}
