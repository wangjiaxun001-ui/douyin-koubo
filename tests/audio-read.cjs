const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/fast.js'), 'utf8');
const media = 'https://test.douyinvod.com/full-audio';
function reader({size = 64, status = 200, duration = 868.696, decode} = {}) {
  let requests = 0, cancellations = 0;
  const timeouts = [];
  const context = vm.createContext({
    URL, Blob, AbortController,
    AbortSignal: {any: AbortSignal.any, timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(ms); }},
    location: {origin: 'https://www.douyin.com'},
    fetch: async () => {
      requests++;
      return {
        ok: status === 200, status,
        headers: new Headers({'content-length': String(size * 1024 * 1024)}),
        body: {
          async cancel() { cancellations++; },
          getReader() {
            let done = false;
            return {async read() {if (done) return {done: true}; done = true; return {done: false, value: new Uint8Array(16)}; }};
          }
        }
      };
    },
    OfflineAudioContext: class {
      decodeAudioData() { return decode ? decode() : Promise.resolve({duration}); }
    }
  });
  vm.runInContext(source, context);
  return {read: context.__shijuReadTrack, timeouts, counts: () => ({requests, cancellations})};
}
const video = {duration: 868.696, currentSrc: 'blob:https://www.douyin.com/player'};
test('a 14-minute work can read a 179 MiB media file and reports download/decode stages', async () => {
  const r = reader({size:179}), progress = [];
  const result = await r.read(video, [], new AbortController().signal, [media], p => progress.push(p.stage));
  assert.equal(result.duration, video.duration);
  assert.deepEqual(progress, ['download', 'download', 'decode']);
  assert.ok(r.timeouts.includes(300000));
  assert.ok(r.timeouts.includes(480000));
});
test('45 minutes and 512 MiB are accepted, longer recordings stop before downloading', async () => {
  const duration = 45 * 60;
  const r = reader({duration, size:512});
  await r.read({...video, duration}, [], new AbortController().signal, [media]);
  await assert.rejects(r.read({...video, duration:duration+1}, [], new AbortController().signal, [media]), /45 分钟/);
  assert.equal(r.counts().requests, 1);
});
test('oversized media cancels its response and reports the actual limit', async () => {
  const r = reader({size: 513});
  await assert.rejects(r.read(video, [], new AbortController().signal, [media]), /512 MiB/);
  assert.equal(r.counts().cancellations, 1);
});
test('HTTP failures, missing addresses and wrong-work durations have distinct messages', async () => {
  await assert.rejects(reader({status: 403}).read(video, [], new AbortController().signal, [media]), /HTTP 403/);
  const r = reader();
  await assert.rejects(r.read(video, [], new AbortController().signal, ['https://unrelated.example/audio']), /完整音轨地址/);
  assert.equal(r.counts().requests, 0);
  await assert.rejects(reader({duration: 10}).read(video, [], new AbortController().signal, [media]), /时长与当前视频不一致/);
});
test('stopping while audio decoding is pending promptly rejects', async () => {
  const controller = new AbortController();
  const r = reader({decode: () => {controller.abort(); return new Promise(() => {}); }});
  await assert.rejects(r.read(video, [], controller.signal, [media]), {name:'AbortError'});
});
test('the extraction button explains a job in another tab and recovers after failure', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      firstChild: {textContent:''}, dataset:{}, options:[],
      replaceChildren(){this.options=[];},
      add(option){this.options.push(option);},
      setAttribute(){},
      removeAttribute(name){this.removed=name;}
    });
    return elements.get(id);
  };
  const popup = fs.readFileSync(path.join(__dirname, '../extension/popup.js'), 'utf8');
  const draw = popup.slice(popup.indexOf('function draw('), popup.indexOf('chrome.storage.onChanged'));
  const context = vm.createContext({
    el:element, workTab:'1', starting:false, mode:'raw', j:null,
    syncKakaJob(){}, timeTag: String, transcript(){return '';}, scriptText(){return '';}
  });
  vm.runInContext(draw,context);
  const job={tab:2,token:'test',phase:'loading',title:'另一条作品',message:'正在读取完整音轨…',duration:868,time:0,rows:[]};
  context.draw(job);
  assert.equal(element('start').disabled,true);
  assert.match(element('start').firstChild.textContent,/另一条/);
  assert.equal(element('bar').removed,'value');
  context.draw({...job,phase:'error',message:'下载超时'});
  assert.equal(element('start').disabled,false);
  assert.equal(element('status').textContent,'下载超时');
  context.draw({...job,tab:1});
  assert.match(element('start').firstChild.textContent,/正在提取，请稍候/);
  context.starting=true;
  context.draw(null);
  assert.match(element('start').firstChild.textContent,/正在连接视频/);
});
