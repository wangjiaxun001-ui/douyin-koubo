// Isolated local UI fixture; this does not use the user's Chrome profile.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://shiju.test/**',route=>{
      const file=path.basename(new URL(route.request().url()).pathname);
      const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
      return route.fulfill({contentType:type,body:fs.readFileSync(path.join(__dirname,'../extension',file))});
    });
    await page.addInitScript(()=>{
      window.calls=[];window.nativeAllowed=true;
      const job={token:'fixture',tab:1,phase:'done',duration:3,time:3,
        workId:'1234567890123',source:'原声精校',message:'已按原声精校并断句。',
        captionNote:'本次未取得可核对的画面字幕，结果来自原声听写，可能与视频字幕不同。',
        rows:[{s:0,e:3,t:'测试逐字稿'}]};
      window.chrome={
        storage:{session:{get:async()=>({job}),set:async()=>{}},onChanged:{addListener(){}}},
        permissions:{request:async request=>{calls.push({permission:request});return nativeAllowed;}},
        tabs:{get:async()=>({id:1,url:'https://www.douyin.com/video/1234567890123'})},
        runtime:{sendMessage:async message=>{calls.push(message);return {ok:true};}}
      };
    });
    await page.goto('http://shiju.test/popup.html?workTab=1');
    await page.locator('#retry').waitFor({state:'visible'});
    assert.match(await page.locator('#captionNote').innerText(),/原声听写/);
    assert.equal(await page.locator('#asrMode').inputValue(),'picture');
    assert.equal(await page.locator('#force').isDisabled(),true);
    assert.equal(await page.locator('#transcriptEditor').inputValue(),'测试逐字稿');
    await page.locator('#retry').click();
    await page.waitForFunction(()=>calls.some(x=>x.op==='start'));
    let calls=await page.evaluate(()=>window.calls);
    assert.deepEqual(calls[0].permission,{permissions:['nativeMessaging']});
    assert.equal(calls[1].fresh,true);assert.equal(calls[1].force,false);
    assert.equal(calls[1].mode,'picture');
    // The UI dispatches the selected mode; strict no-fallback behavior is tested in transcript-quality.cjs.
    await page.evaluate(()=>{window.calls=[];window.nativeAllowed=false;});
    await page.locator('#start').click();
    await page.waitForFunction(()=>calls.some(x=>x.op==='start'));
    calls=await page.evaluate(()=>window.calls);
    assert.equal(calls[1].fresh,false);assert.equal(calls[1].force,false);
    assert.deepEqual(errors,[]);
    console.log('PASS visible source warning, plain transcript, fresh retry and native permission request/denial');
    if(process.env.SHIJU_PICTURE_RESULT){
      const actual=JSON.parse(fs.readFileSync(process.env.SHIJU_PICTURE_RESULT,'utf8'));
      await page.evaluate(result=>draw({token:'real-native-output',tab:1,phase:'done',duration:181.4666667,time:181.4666667,
        workId:'7683560282806881579',source:'画面字幕',title:'真实视频字幕验收',message:'已提取画面字幕',
        captionNote:'文字直接来自画面，未使用语音听写。',rows:result.captions}),actual);
      assert.equal(await page.locator('#source').innerText(),'画面字幕');
      assert.equal(await page.locator('#transcriptEditor').inputValue(),actual.captions.map(r=>r.t).join('\n'));
      assert.equal(await page.locator('#result').isVisible(),true);
      assert.deepEqual(errors,[]);
      console.log('PASS actual native transcript rendered as plain text:',actual.captions.length,'lines');
    }

  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
