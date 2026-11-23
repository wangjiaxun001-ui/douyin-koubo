const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=name=>fs.readFileSync(path.join(__dirname,'../extension',name),'utf8');
test('edits save on the current completed job without changing source cues; stale/running edits fail',async()=>{
 let listener,saved;
 const original={token:'edit',phase:'done',rows:[{s:0,e:3,t:'旧错字'}]};
 const chrome={storage:{session:{get:async()=>({job:original}),set:async x=>{saved=x.job;}}},
 runtime:{onMessage:{addListener(fn){listener=fn;}}},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}}};
 const context=vm.createContext({chrome,importScripts(){},structuredClone});
 vm.runInContext(code('background.js'),context);await vm.runInContext('init',context);
 const send=m=>new Promise(resolve=>listener({to:'bg',op:'editTranscript',...m},{},resolve));
 const reply=await send({token:'edit',text:'新正文\n新增段落'});assert.equal(reply.ok,true);assert.equal(reply.revision,1);
 assert.equal(saved.editedText,'新正文\n新增段落');assert.equal(saved.rows[0].t,'旧错字');
 await send({token:'edit',text:''});assert.equal(saved.editedText,'');
 assert.match((await send({token:'stale',text:'另一篇'})).error,/另一篇/);
 vm.runInContext("state.phase='fast'",context);
 assert.match((await send({token:'edit',text:'处理中不改'})).error,/完成后/);
});
test('copy and script breakdown use edited text, including intentional deletion, without invented timestamps',()=>{
 const c=vm.createContext({});vm.runInContext(code('format.js'),c);
 c.job={phase:'done',rows:[{s:0,e:3,t:'旧错字'}],editedText:'修改后的开头\n新增中间段落\n我的结尾'};
 assert.equal(vm.runInContext('transcript(job)',c),c.job.editedText);
 const script=vm.runInContext('scriptText(job)',c);assert.match(script,/新增中间段落/);assert.doesNotMatch(script,/旧错字|00:00/);
 c.job.editedText='';assert.equal(vm.runInContext('transcript(job)',c),'');
 delete c.job.editedText;assert.equal(vm.runInContext('transcript(job)',c),'旧错字');
});
