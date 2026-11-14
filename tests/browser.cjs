// CHROME points to Chrome for Testing. NODE_PATH must include playwright.
// TEST_VOICE is a 16 kHz mono WAV of the phrase in README. LIVE=1 runs an actual public work.
const { chromium }=require('playwright'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const delay=n=>new Promise(r=>setTimeout(r,n));
async function rpc(url){const sock=new WebSocket(url);await new Promise((ok,no)=>{sock.onopen=ok;sock.onerror=no});let id=0,cb=new Map();sock.onmessage=e=>{const m=JSON.parse(e.data);if(cb.has(m.id)){cb.get(m.id)(m);cb.delete(m.id)}};return async(method,params={})=>{const n=++id;const res=new Promise(r=>cb.set(n,r));sock.send(JSON.stringify({id:n,method,params}));const m=await res;if(m.error)throw Error(JSON.stringify(m.error));return m.result}}
(async()=>{
 const ext=path.resolve(__dirname,'../extension'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'shiju-test-'));
 const proc=spawn(process.env.CHROME,['--remote-debugging-port=0','--remote-debugging-pipe','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--enable-unsafe-extension-debugging','--user-data-dir='+profile,'--load-extension='+ext,'--disable-extensions-except='+ext,'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});proc.stderr.on('data',()=>{});
 let b;
 try {
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0],http='http://127.0.0.1:'+port;
 b=await chromium.connectOverCDP(http);const ctx=b.contexts()[0];const page=ctx.pages()[0];page.setDefaultTimeout(8000);
 const cdp=await b.newBrowserCDPSession();const id=(await cdp.send('Extensions.getExtensions')).extensions.find(x=>x.path===ext).id;
 const match=x=>x.url()==='chrome-extension://'+id+'/background.js';const sw=ctx.serviceWorkers().find(match)||await ctx.waitForEvent('serviceworker',{predicate:match,timeout:8000});
 const pc=await ctx.newCDPSession(page);const targetId=(await cdp.send('Target.getTargets',{filter:[{type:'tab'}]})).targetInfos[0].targetId;await cdp.send('Browser.setPermission',{permission:{name:'clipboard-read'},setting:'granted',origin:'chrome-extension://'+id});
 async function popup(){await page.bringToFront();await delay(400);await cdp.send('Extensions.triggerAction',{id,targetId});let t;for(let i=0;i<50&&!t;i++){t=(await (await fetch(http+'/json/list')).json()).find(x=>x.url.endsWith('/popup.html'));if(!t)await delay(100)}assert(t,'popup');const call=await rpc(t.webSocketDebuggerUrl);
 return async expr=>{const r=await call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'popup JS failed');return r.result.value}
 }
 const state=()=>sw.evaluate(async()=> (await chrome.storage.session.get('job')).job);
 async function until(pred,limit=30000){let j;for(let t=0;t<limit;t+=250){j=await state();if(j&&pred(j))return j;await delay(250)}throw Error('timeout: '+JSON.stringify(j))}
 const finished=j=>['error','partial','empty','done','unavailable'].includes(j.phase);
 if(process.env.LIVE){
 const url=process.env.TEST_VIDEO_URL||'https://www.douyin.com/video/7686819974069128483';
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});
 await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.duration>10),null,{timeout:30000});
 await page.waitForTimeout(1200);
 const position=()=>page.evaluate(()=>{const v=[...document.querySelectorAll('video')].find(v=>v.duration>10);return {time:v.currentTime,paused:v.paused}});
 await page.evaluate(()=>[...document.querySelectorAll('video')].forEach(v=>v.pause()));
 const before=await position();const ev=await popup();
 await ev('document.querySelector("#force").checked=true;document.querySelector("#start").click()');
 const j=await until(finished,240000);const after=await position();
 console.log('LIVE',JSON.stringify({phase:j.phase,reason:j.message,title:j.title,source:j.source,duration:j.duration,time:j.time,firstMs:j.firstAt-j.startedAt,totalMs:j.endedAt-j.startedAt,segments:j.rows.length,first:j.rows[0],last:j.rows.at(-1),before,after}));
 assert.equal(j.phase,'done');assert.equal(j.source,'快速音轨转写');assert(j.rows.length);assert(after.paused && Math.abs(after.time-before.time)<0.2);return;
 }
 const wav=fs.readFileSync(process.env.TEST_VOICE);let caps=true;
 await ctx.route('https://www.douyin.com/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/speech.wav'&&caps==='partial'&&route.request().resourceType()==='fetch')return route.fulfill({status:404,body:''});if(u.pathname==='/speech.wav')return route.fulfill({contentType:'audio/wav',body:wav});
 if(u.pathname==='/captions.vtt'&&caps==='partial')return route.fulfill({contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n只有第一句\n'});
 if(u.pathname==='/captions.vtt')return route.fulfill({contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n嗯，嗯，今天测试。\n\n00:00:03.000 --> 00:00:07.750\n最后记得检查文字。\n'});
 return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><title>分享描述不是逐字稿</title><video preload="auto" controls style="width:500px;height:320px" src="/speech.wav">'+(caps?'<track kind="captions" srclang="zh" src="/captions.vtt">':'')+'</video>'})});
 async function sample(n){await page.goto('https://www.douyin.com/video/'+n);await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);await page.evaluate(()=>{document.querySelector('video').currentTime=2})}
 await sample(123);let ev=await popup();await ev('document.querySelector("#start").click()');let j=await until(finished);assert.equal(j.phase,'done',j.message);assert.equal(j.source,'网页字幕');assert.equal(j.rows[0].t,'嗯，嗯，今天测试。');
 for(const [button,needle] of [['copyRaw','嗯，嗯，今天测试。'],['copyScript','【开场】']]){
 await ev('document.querySelector("#'+button+'").click()');await delay(200);
 const clip=await ev('navigator.clipboard.readText()');if(button==='copyRaw')assert.equal(clip,'嗯，嗯，今天测试。\n最后记得检查文字。');else assert(clip.includes(needle),'clipboard mismatch');assert(!clip.includes('分享描述'))}
 console.log('PASS actual popup, subtitle extraction and both clipboard reads');
 caps=false;await sample(456);ev=await popup();await ev('document.querySelector("#start").click()');j=await until(x=>x.token!==j.token&&finished(x),60000);console.log('ASR',JSON.stringify(j));assert.equal(j.phase,'done',j.message);assert.equal(j.source,'快速音轨转写');assert(j.rows.map(r=>r.t).join('').includes('测试'));assert(j.rows.map(r=>r.t).join('').includes('文字'));
 assert.equal(j.rows.map(r=>r.t).join(''),'今天我们来做一个测试打开手机把视频链接复制下来最后记得检查文字'); const before=j.token;caps='partial';await sample(789);ev=await popup();await ev('document.querySelector("#start").click()');await until(x=>x.token!==before&&x.phase==='unavailable');await ev('document.querySelector("#listen").click()');await until(x=>x.phase==='listening');await delay(1300);await page.evaluate(()=>document.querySelector('video').currentTime=5);j=await until(x=>x.token!==before&&finished(x));assert.equal(j.phase,'partial',j.message);console.log('PASS incomplete captions fall back to ASR; seek yields partial');
 }finally{await b?.close().catch(()=>{});proc.kill();await delay(500);fs.rmSync(profile,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
