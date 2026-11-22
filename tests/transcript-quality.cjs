const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const code = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');

test('fresh extraction bypasses old text while still reading original subtitles', async () => {
  for (const fresh of [false, true]) {
    let probe;
    const old = {phase:'done', source:'网页字幕', workId:'1234567890123', duration:10,
      rows:[{s:0,e:10,t:'旧错稿'}], mode:'precise'};
    const chrome = {
      storage:{session:{get:async()=>({job:old}),set:async()=>{}}},
      permissions:{contains:async()=>true},
      tabs:{get:async()=>({url:'https://www.douyin.com/video/'+old.workId}),
        onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
      scripting:{executeScript:async options => {
        if(options.files)return [];
        const [op,,args]=options.args;
        if(op==='release')return [{result:{value:true}}];
        assert.equal(op,'probe'); probe=args;
        const reuse=args.previousId===old.workId;
        return [{result:{value:{workId:old.workId,duration:10,reuse,
          rows:reuse?[]:[{s:0,e:10,t:'重新取得的原字幕'}]}}}];
      }},
      runtime:{onMessage:{addListener(){}}}
    };
    const context=vm.createContext({chrome,importScripts(){},structuredClone,URL,
      crypto:{randomUUID:()=> 'new-job'},precisionSessions:new Map()});
    vm.runInContext(code('background.js'),context);
    await vm.runInContext('init',context);
    await context.start(1,false,'precise','',()=>{},fresh);
    const job=vm.runInContext('state',context);
    assert.equal(probe.skip,false,'refresh must not disable original subtitles');
    assert.equal(job.rows[0].t,fresh?'重新取得的原字幕':'旧错稿');
    assert.equal(job.source,'网页字幕');
  }
});

test('precision results disclose whether original picture captions were available', async () => {
  for (const scenario of ['unavailable','incomplete','error','matched','voice-only']) {
    let receive;
    const job={mode:'precise',token:'test',phase:'loading',tab:1,duration:3,rows:[],
      terms:'始祖鸟',forceVoice:scenario==='voice-only'};
    const captions=[{s:0,e:3,t:'始祖鸟'}];
    const chrome={permissions:{contains:async()=>true},
      scripting:{executeScript:async()=>[{result:[]}]},
      runtime:{connectNative:()=>({
        onDisconnect:{addListener(){}},onMessage:{addListener(fn){receive=fn;}},disconnect(){},
        postMessage(message){queueMicrotask(()=>{
          if(message.op==='transcribe')receive({ready:true});
          else if(message.op==='finish'){
            receive({rows:[{s:0,e:3,t:'始祖乌'}]});
            receive({done:true,pictureStatus:scenario,captions:scenario==='matched'?captions:null});
          }else receive({received:true});
        });}
      })}};
    const context=vm.createContext({chrome,state:job,save:async()=>{},guard:()=>{},
      playerAddresses(){},readAudio:async()=>1,setTimeout,clearTimeout,
      page:async(_job,op)=>op==='samples'?{count:1,pcm:'AAA='}:op==='videoBytes'?0:true,
      end:async(_job,phase,message)=>Object.assign(job,{phase,message})});
    vm.runInContext(code('precision.js'),context);
    assert.equal(await context.tryPrecision(job),true);
    assert.equal(job.phase,'done');
    if(scenario==='matched'){
      assert.equal(job.source,'画面字幕');assert.equal(job.rows[0].t,'始祖鸟');
    }else{
      assert.equal(job.source,'原声精校');assert.equal(job.rows[0].t,'始祖乌');
      assert.match(job.captionNote,/听写/);
    }
    if(scenario==='error')assert.match(job.captionNote,/核对失败/);
    if(scenario==='incomplete')assert.match(job.captionNote,/未能完整/);
    if(scenario==='voice-only')assert.match(job.captionNote,/你选择/);
  }
});
