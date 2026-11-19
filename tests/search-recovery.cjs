const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const id = '7067498666361113887';
const target = 'https://www.douyin.com/video/' + id;
const search = 'https://www.douyin.com/video/7434738007795649855/search/car?modal_id=' + id;

async function fixture({url = search, code = 'NO_MEDIA_URL', probeId = id, duration = 868.649002, failAgain = false, redirect, stopped = false, hangs = false} = {}) {
  let tab = {id:1, url, status:'complete'}, reads = 0, probes = 0, injections = 0, now = 0;
  const navigations = [], snapshots = [], events = {};
  let context;
  const job = {tab:1, token:'test', workId:id, phase:'loading', duration:868.696, rows:[], message:''};
  const chrome = {
    storage:{session:{get:async()=>({}), set:async value=>snapshots.push(value.job)}},
    runtime:{onMessage:{addListener(){}}, sendMessage:async()=>({})},
    tabs:{
      get:async()=>tab,
      update:async(tabId, change)=>{
        navigations.push(change.url);
        tab = {...tab, url:redirect || change.url, status:'loading'};
        await events.updated(tabId, {status:'loading', url:tab.url}, tab);
        if(stopped) job.phase = 'partial';
        if(!hangs)tab.status = 'complete';
        return tab;
      },
      onUpdated:{addListener(fn){events.updated = fn;}},
      onRemoved:{addListener(){}}
    },
    scripting:{executeScript:async options=>{
      if(options.files){injections++; return [];}
      const fn = vm.runInContext('(' + options.func.toString() + ')', context);
      return [{result:await fn(...options.args)}];
    }}
  };
  context = vm.createContext({
    chrome, importScripts(){}, structuredClone, URL, precisionSessions:new Map(),
    document:{querySelectorAll:()=>[]},
    Date:{now:()=>now}, setTimeout(fn, ms){now += ms; queueMicrotask(fn);},
    __shiju:async op=>{
      if(op === 'readTrack'){
        reads++;
        if(reads === 1 || failAgain)throw Object.assign(Error('missing audio'), {code});
        return 13898384;
      }
      if(op === 'probe'){probes++; return {workId:probeId, duration};}
    }
  });
  vm.runInContext(source, context);
  await vm.runInContext('init', context);
  context.testJob = job;
  vm.runInContext('state = testJob', context);
  return {job, context, navigations, snapshots, events, tab:()=>tab,
    run:()=>context.readAudio(job), counts:()=>({reads, probes, injections})};
}

test('search overlay uses modal_id, opens the same work and continues the existing job', async()=>{
  const f = await fixture();
  assert.equal(f.context.workIdFromUrl(search), id);
  assert.equal(await f.run(), 13898384);
  assert.deepEqual(f.navigations, [target]);
  assert.deepEqual(f.counts(), {reads:2, probes:1, injections:1});
  assert.equal(f.job.phase, 'loading');
  assert.equal(f.job.duration, 868.649002);
  assert.equal(f.job.recoveryUrl, undefined);
  assert.ok(f.snapshots.some(j=>j.message.includes('独立页面继续提取')));
});
test('direct pages and HTTP/decode failures do not cause navigation loops', async()=>{
  for(const options of [{url:target}, {code:'HTTP_ERROR'}]){
    const f = await fixture(options);
    await assert.rejects(f.run(), /missing audio/);
    assert.deepEqual(f.navigations, []);
  }
  const f = await fixture({failAgain:true});
  await assert.rejects(f.run(), /missing audio/);
  assert.equal(f.navigations.length, 1);
  assert.equal(f.counts().reads, 2);
});
test('an already switched work is never redirected back behind the user', async()=>{
  const f = await fixture({url:'https://www.douyin.com/video/999'});
  await assert.rejects(f.run(), /作品已切换/);
  assert.deepEqual(f.navigations, []);
});
test('recovery rejects another work or mismatched duration before reading its audio', async()=>{
  for(const options of [{probeId:'999'}, {duration:10}]){
    const f = await fixture(options);
    await assert.rejects(f.run(), /作品或时长不一致/);
    assert.equal(f.counts().reads, 1);
    assert.equal(f.job.recoveryUrl, undefined);
  }
});
test('user navigation and stop during recovery terminate the attempt', async()=>{
  for(const options of [{redirect:'https://www.douyin.com/video/999'}, {stopped:true}]){
    const f = await fixture(options);
    await assert.rejects(f.run(), /已停止/);
    assert.equal(f.counts().reads, 1);
    assert.equal(f.job.recoveryUrl, undefined);
  }
});
test('a hanging navigation has a bounded timeout and clears the recovery state', async()=>{
  const f = await fixture({hangs:true});
  await assert.rejects(f.run(), /加载超时/);
  assert.equal(f.job.recoveryUrl, undefined);
  assert.equal(f.counts().reads, 1);
});
test('manual refresh after recovery still stops the extraction', async()=>{
  const f = await fixture();
  await f.run();
  await f.events.updated(1, {status:'loading'}, f.tab());
  assert.equal(f.job.phase, 'partial');
  assert.equal(f.job.message, '视频页面已刷新或跳转');
});
