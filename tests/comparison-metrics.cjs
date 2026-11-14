// Run with Node, Playwright and installed Google Chrome. Uses a disposable browser profile.
const {chromium}=require('playwright'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const dir=path.resolve(__dirname,'../extension');
(async()=>{
 const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1);
  if(['compare.html','metrics.js','rewrite.js','compare.js','navigation.js'].includes(name)){
   res.setHeader('content-type',name.endsWith('js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
   res.end(fs.readFileSync(path.join(dir,name)));
  }else res.end('');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let b;try{
  b=await chromium.launch({channel:'chrome',headless:true});
  const p=await b.newPage({viewport:{width:1080,height:760}}),errors=[];p.on('pageerror',e=>errors.push(String(e)));
  const origin='http://127.0.0.1:'+server.address().port,url='https://www.douyin.com/video/123';
  await p.goto(origin+'/video/123');
  await p.addScriptTag({url:origin+'/metrics.js'});
  await p.locator('body').evaluate(body=>{const s=document.createElement('script');s.type='application/json';s.textContent=JSON.stringify([{aweme_id:'444',author:{follower_count:999},statistics:{digg_count:888}},{aweme_id:'123',author:{follower_count:0},statistics:{digg_count:'1.2万',comment_count:13}}]);body.append(s)});
  const measured=await p.evaluate(()=>ShijuMetrics.read(ShijuMetrics.workId()));
  assert.deepEqual(measured,{fans:'',likes:'1.2万',comments:'13'});
  assert.deepEqual(await p.evaluate(()=>ShijuMetrics.read('444')),{fans:'',likes:'',comments:''});
  // A modal may preload the neighbour. Take toolbar counts and author data from the exact slide only.
  await p.evaluate(()=>{document.body.innerHTML='<div data-e2e="feed-active-video" data-e2e-vid="444"><span data-e2e="video-player-digg">999</span></div><div data-e2e="feed-active-video" data-e2e-vid="123"><span data-e2e="video-player-digg">0</span><span data-e2e="feed-comment-icon">31</span><a data-e2e="video-avatar" href="/user/abcdefgh"></a><a id="loaded" href="/user/abcdefgh">0粉丝</a><div role="tablist"><button role="tab" id="prior" aria-selected="true">收藏夹</button><button role="tab" id="semiTabauthor_card" aria-selected="false">TA的作品</button></div></div>';
   const a=document.querySelector('#semiTabauthor_card'),prior=document.querySelector('#prior');
   a.onclick=()=>{a.setAttribute('aria-selected','true');prior.setAttribute('aria-selected','false');setTimeout(()=>document.querySelector('#loaded').textContent='8465粉丝 34万获赞',300)};
   prior.onclick=()=>{a.setAttribute('aria-selected','false');prior.setAttribute('aria-selected','true')};
  });
  assert.deepEqual(await p.evaluate(()=>ShijuMetrics.read('123')),{fans:'8465',likes:'0',comments:'31'});
  assert.equal(await p.locator('#prior').getAttribute('aria-selected'),'true');
  await p.addInitScript(({url,measured})=>{
   const p={id:'old',title:'旧文案',filename:'',names:['甲','乙'],sources:[url,''],raw:['甲段','乙段'],imported:['甲段','乙段'],cells:{'0/开头/0':'甲段','1/开头/0':'乙段'},order:['1/开头/0'],middles:1,finalText:'手改的旧终稿',generatedFrom:'乙段'};
   if(!localStorage.getItem('shiju-script-editor.v1'))localStorage.setItem('shiju-script-editor.v1',JSON.stringify({active:'old',projects:[p]}));
   window.chrome.storage={session:{get:async k=>k==='job'?{job:{token:'one',workId:'456',title:'新片',rows:[{t:'新段'}],metrics:{comments:'7'}}}:{[k]:{id:'123',values:measured}},remove:async()=>{}}};
  },{url,measured});
  await p.goto(origin+'/compare.html');
  await p.evaluate(()=>{
   chrome.runtime={getURL:s=>'chrome-extension://example/'+s,getContexts:async()=>[{tabId:31,windowId:9,documentUrl:'chrome-extension://example/popup.html?workTab=17'}]};
   const get=chrome.storage.session.get;
   chrome.storage.session.get=async k=>Array.isArray(k)?{extractReturn:{id:31,url:'chrome-extension://example/popup.html?workTab=17'}}:get(k);
   chrome.tabs={update:async id=>window.focusedExtract=id};chrome.windows={update:async()=>{}};
  });
  await p.locator('#return-extract').click();assert.equal(await p.evaluate(()=>window.focusedExtract),31);const badge=p.locator('.metric-strip').first();
  assert.equal(await p.locator('#final-text').inputValue(),'手改的旧终稿');
  await p.locator('.edit-metrics').first().click();await p.getByRole('textbox',{name:'第 1 篇评论数',exact:true}).fill('9');
  await p.evaluate(()=>location.hash='metrics=demo');
  await p.waitForFunction(()=>document.querySelector('.metric-strip').innerText.includes('1.2万'));
  assert.equal(await badge.innerText(),'粉丝 —\n点赞 1.2万\n评论 13');
  assert((await p.locator('.metric-strip').nth(1).innerText()).includes('粉丝 —'));
  assert.equal(await p.locator('#queue li').count(),1);
  await p.reload();assert((await badge.innerText()).includes('评论 13'));
  await p.evaluate(()=>location.hash='job=one');await p.waitForFunction(()=>document.querySelectorAll('.metric-strip').length===3);
  assert((await p.locator('.metric-strip').nth(2).innerText()).includes('评论 7'));
  await p.locator('[data-step="compare"]').click();await p.locator('[data-pick="0/开头/0"]').check();
  await p.locator('[data-step="draft"]').click();p.once('dialog',d=>d.accept());await p.locator('#generate').click();
  assert.equal(await p.locator('#final-text').inputValue(),'甲段\n\n乙段');assert.equal(await p.locator('[data-step=final]').getAttribute('aria-current'),'step');
  // Reproduce a legacy draft where the first middle paragraph was checked before its opening.
  await p.evaluate(()=>{
   const key='shiju-script-editor.v1',lib=JSON.parse(localStorage.getItem(key)),d=lib.projects.find(p=>p.id===lib.active);
   delete d.orderMode;d.middles=10;d.order=['0/中间/0','0/开头/0','0/结尾/0','0/中间/9','0/中间/1'];
   for(const k of d.order)d.cells[k]=k;d.finalText='人工改过的稿';localStorage.setItem(key,JSON.stringify(lib));
  });
  const queue=()=>p.locator('#queue [data-draft]').evaluateAll(els=>els.map(e=>e.dataset.draft));
  await p.reload();const sorted=['0/开头/0','0/中间/0','0/中间/1','0/中间/9','0/结尾/0'];
  assert.deepEqual(await queue(),sorted);assert.equal(await p.locator('#final-text').inputValue(),'人工改过的稿');
  await p.locator('#undo-order').click();assert.equal((await queue())[0],'0/中间/0');
  await p.locator('#table-order').click();await p.locator('#queue li').first().getByText('下移').click();
  await p.reload();assert.equal((await queue())[0],'0/中间/0');
  await p.locator('#table-order').click();
  await p.locator('[data-pick="0/中间/0"]').uncheck();await p.locator('[data-pick="0/中间/0"]').check();
  assert.deepEqual(await queue(),sorted);p.once('dialog',d=>d.accept());await p.locator('#generate').click();
  assert.equal(await p.locator('#final-text').inputValue(),sorted.join('\n\n'));
  await p.locator('#new-project').click();
  await p.locator('#topic').fill('待删选题');
  const deleteButton=p.getByRole('button',{name:'删除选题',exact:true});
  p.once('dialog',d=>{assert(d.message().includes('待删选题'));return d.dismiss()});
  await deleteButton.click();
  assert.equal(await p.locator('#projects option').count(),2);
  p.once('dialog',d=>d.accept());await deleteButton.click();await p.reload();
  assert.equal(await p.locator('#projects option').count(),1);
  assert.equal(await p.locator('#final-text').inputValue(),sorted.join('\n\n'));
  p.once('dialog',d=>d.accept());await deleteButton.click();await p.reload();
  assert.equal(await p.locator('#projects option').count(),1);
  assert.equal(await p.locator('#topic').inputValue(),'');
  assert.equal(await p.locator('#final-text').inputValue(),'');
  // Manual comparison and optional AI use the same source columns.
  assert.equal(await p.locator('#ai-panel').isVisible(),false);
  const raw=p.locator('#inputs textarea');
  await raw.nth(0).fill('我的事实和观点。');
  await raw.nth(1).fill('博主的参考段落。');
  await p.locator('#ai-toggle').check();
  await p.locator('#ai-instruction').fill('保留事实，缩短开场');
  const providers=[
    ['DeepSeek','https://api.deepseek.com/chat/completions'],
    ['Gemini','https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'],
    ['豆包','https://ark.cn-beijing.volces.com/api/v3/chat/completions']
  ];
  for (const [i,[name,url]] of providers.entries()) {
    await p.locator('#ai-provider').selectOption(name);
    await p.locator('#ai-key').fill('fixture-key');
    await p.route(url,async route=>{
      const req=route.request(),body=req.postDataJSON(),gemini=name==='Gemini';
      const sent=gemini?body.contents[0].parts[0].text:body.messages[1].content;
      assert(sent.includes('我的事实和观点。') && sent.includes('缩短开场') && !sent.includes('博主的参考段落'));
      assert.equal(req.headers()[gemini?'x-goog-api-key':'authorization'],gemini?'fixture-key':'Bearer fixture-key');
      const result=gemini?{candidates:[{finishReason:'STOP',content:{parts:[{text:name+'版本。'}]}}]}:
        {choices:[{finish_reason:'stop',message:{content:name+'版本。'}}]};
      await route.fulfill({json:result});
    });
    await p.locator('#ai-generate').click();
    await p.waitForFunction(n=>document.querySelectorAll('#inputs textarea').length===n,i+3);
    assert.equal(await raw.nth(i+2).inputValue(),name+'版本。');
  }
  await p.locator('#ai-generate').click();
  await p.waitForFunction(()=>document.querySelectorAll('#inputs textarea').length===6);
  assert.equal(await raw.nth(0).inputValue(),'我的事实和观点。');
  assert.equal(await raw.nth(1).inputValue(),'博主的参考段落。');
  const endpoint=providers[2][1];await p.unroute(endpoint);
  let release;const paused=new Promise(r=>{release=r});
  await p.route(endpoint,async route=>{await paused;await route.fulfill({json:{choices:[{finish_reason:'stop',message:{content:'已取消的版本'}}]}}).catch(()=>{})});
  const started=p.waitForRequest(endpoint);
  await p.locator('#ai-generate').click();await started;
  await p.locator('#ai-toggle').uncheck();release();
  await p.locator('#add-source').click();await raw.last().fill('另一位博主稿。');
  await p.locator('#import').click();
  assert.equal(await p.locator('[data-cell="6/开头/0"]').inputValue(),'另一位博主稿。');
  await p.reload();assert.equal(await raw.count(),7);
  assert.equal(await p.locator('#ai-toggle').isChecked(),false);
  assert.equal(await p.locator('#ai-key').inputValue(),'');
  assert(!(await p.evaluate(()=>JSON.stringify(localStorage))).includes('fixture-key'));
  await p.locator('[data-pick="1/开头/0"]').check();
  await p.locator('[data-pick="6/开头/0"]').check();
  await p.locator('#final-text').fill('手写终稿');
  await p.locator('[data-step=intake]').click();
  const remove=p.locator('.source-heading button');
  p.once('dialog',d=>d.dismiss());await remove.nth(1).click();
  assert.equal(await raw.count(),7);
  p.once('dialog',d=>{assert(d.message().includes('博主参考稿'));return d.accept()});
  await remove.nth(1).click();await p.reload();
  assert.equal(await raw.count(),6);
  assert.equal(await raw.nth(0).inputValue(),'我的事实和观点。');
  assert.equal(await raw.nth(5).inputValue(),'另一位博主稿。');
  assert.deepEqual(await queue(),['5/开头/0']);
  assert.equal(await p.locator('#final-text').inputValue(),'手写终稿');
  await p.locator('[data-step=intake]').click();
  while(await remove.count()){p.once('dialog',d=>d.accept());await remove.last().click()}
  await p.reload();assert.equal(await raw.count(),0);
  await p.locator('#add-source').click();await raw.first().fill('重新添加的博主稿');
  await p.locator('#import').click();
  assert.equal(await p.locator('[data-cell="0/开头/0"]').inputValue(),'重新添加的博主稿');
  await p.setViewportSize({width:390,height:800});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS Google Chrome: exact-work metrics, missing vs zero, verified refresh replaces manual counts, old draft migration, import, navigation, final text, narrow viewport.');
 }finally{await b?.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
