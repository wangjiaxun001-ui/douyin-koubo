// An isolated Chrome fixture, not the user's Chrome profile.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1080,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/**',route=>{
   const name=path.basename(new URL(route.request().url()).pathname),file=path.join(__dirname,'../extension',name);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(file)});
  });
  await page.addInitScript(()=>{
   const original={token:'edit-ui',tab:1,phase:'done',duration:89,time:89,source:'画面字幕',title:'口播编辑验收',workId:'1234567890123',message:'已完成',rows:[{s:0,e:2,t:'这个品牌'},{s:2,e:5,t:'欢迎来到Drakstreet'}]};
   let data=JSON.parse(localStorage.getItem('mockChrome')||'null')||{job:original};
   const listeners=[];window.createdTabs=[];
   window.oldJob=structuredClone(original);
   const set=async patch=>{
    const changes={};for(const key of Object.keys(patch)){changes[key]={oldValue:structuredClone(data[key]),newValue:structuredClone(patch[key])};}
    Object.assign(data,structuredClone(patch));localStorage.setItem('mockChrome',JSON.stringify(data));
    for(const fn of listeners)fn(changes,'session');
   };
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});
   window.chrome={storage:{session:{get:async()=>structuredClone(data),set,remove:async()=>{}},onChanged:{addListener:fn=>listeners.push(fn)}},
    tabs:{get:async()=>({id:1,url:'https://www.douyin.com/video/1234567890123'}),getCurrent:async()=>({id:2}),create:async value=>{createdTabs.push(value);}},
    permissions:{request:async()=>true},runtime:{getURL:name=>'http://localhost/'+name,getContexts:async()=>[],sendMessage:async m=>{
     if(m.op==='editTranscript'){
      if(m.token!==data.job.token)return {error:'wrong job'};
      const job={...data.job,editedText:m.text,editRevision:(data.job.editRevision||0)+1};
      await set({job});return {ok:true,revision:job.editRevision};
     }
     return {ok:true};
    }}};
  });
  await page.goto('http://localhost/popup.html?workTab=1');
  const area=page.locator('#transcriptEditor');await area.waitFor();
  assert.equal(await area.inputValue(),'这个品牌\n欢迎来到Drakstreet');
  const text='这个品牌，可以直接修改。\n\n欢迎来到Drakstreet\n这是我新增的一段。';
  await area.fill(text);await page.waitForFunction(()=>document.querySelector('#editStatus').textContent.includes('已自动暂存'));
  await area.evaluate(el=>el.setSelectionRange(5,5));
  // A late notification must not roll back the edit or disturb the selection.
  await page.evaluate(()=>draw(oldJob));
  assert.equal(await area.inputValue(),text);assert.equal(await area.evaluate(el=>el.selectionStart),5);
  await page.locator('#copyRaw').click();assert.equal(await page.evaluate(()=>copied),text);
  await page.locator('#structure').click();assert.match(await page.locator('#preview').innerText(),/新增的一段/);
  assert.doesNotMatch(await page.locator('#preview').innerText(),/00:00/);
  await page.locator('#raw').click();assert.equal(await area.inputValue(),text);
  await page.reload();await area.waitFor();assert.equal(await area.inputValue(),text);
  await area.fill('');await page.waitForFunction(()=>document.querySelector('#editStatus').textContent.includes('已自动暂存'));
  await page.reload();await area.waitFor();assert.equal(await area.inputValue(),'');
  await area.fill(text);await page.locator('#compareJob').click();
  await page.waitForFunction(()=>createdTabs.length>0);
  const target=await page.evaluate(()=>createdTabs.at(-1).url);
  assert.match(target,/#job=edit-ui/);
  await page.goto(target);
  await page.waitForFunction(text=>[...document.querySelectorAll('#inputs textarea')].some(el=>el.value===text),text);
  assert.deepEqual(errors,[]);
  // Verify the actual editing surface at desktop and narrow widths.
  await page.goto('http://localhost/popup.html?workTab=1');await area.waitFor();
  await area.focus();await area.evaluate(el=>el.setSelectionRange(0,0));
  await page.locator('#result').screenshot({path:'/tmp/shiju-edit-desktop.png'});
  await page.setViewportSize({width:390,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('PASS editable text, save/reload, empty draft, late events/cursor, copy, script switch, comparison import and narrow layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
