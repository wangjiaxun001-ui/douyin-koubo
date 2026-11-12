// Keep the transcript and segment selector open while visiting the destination card.
const workTab=new URLSearchParams(location.search).get('workTab');
if(!workTab){
 chrome.tabs.query({active:true,currentWindow:true}).then(async ([tab])=>{
  if(!tab?.id)return;
  if(!ShijuNav.sourceUrl(tab.url)){await ShijuNav.back();window.close();return}
  await chrome.tabs.create({url:chrome.runtime.getURL('popup.html?workTab='+tab.id),openerTabId:tab.id});
  window.close()
 }).catch(()=>{}); // Keep the ordinary popup available when a window cannot open.
}
const el=id=>document.getElementById(id);let j,mode='raw',starting=false;
function draw(x){
 j=x;const busy=['probe','loading','listening','fast','finishing'].includes(x?.phase);
 el('start').disabled=busy||starting;el('options').hidden=busy;el('job').hidden=!x;el('result').hidden=!x?.rows.length;if(!x)return;
 el('source').textContent=x.source||'读取作品';el('title').textContent=x.title;el('status').textContent=/play\(\) failed.*interact/i.test(x.message||'')?'请先回到原视频，点一次播放器，再回来重试。':x.message;
 el('progress').textContent=x.duration?timeTag(x.time)+' / '+timeTag(x.duration):'';el('bar').value=x.duration?x.time/x.duration:0;
 el('listen').hidden=!x.retryListen||busy;el('listen').disabled=starting;
 el('stop').hidden=!busy||x.phase==='finishing';el('preview').textContent=x.rows.length?(mode==='raw'?transcript(x):scriptText(x)):'';
 const sel=el('clipRow'),rows=x.rows;
 if(sel.dataset.job!==x.token||sel.options.length>rows.length){sel.replaceChildren();sel.dataset.job=x.token}
 // Incoming progress must not collapse an open selector or reset the chosen sentence.
 for(let i=sel.options.length;i<rows.length;i++)sel.add(new Option(timeTag(rows[i].s)+'　'+rows[i].t,String(i)));
 el('sendClip').disabled=!/^\d{10,22}$/.test(x.workId||'')||!rows.length;
 el('clipHint').textContent=el('sendClip').disabled?'需要带来源的逐字稿，请在单条作品页重新提取。':'确认后只存原话和时间，不存视频。';
 el('raw').setAttribute('aria-pressed',mode==='raw');el('structure').setAttribute('aria-pressed',mode!=='raw')
}
chrome.storage.onChanged.addListener((c,area)=>{if(area==='session'&&c.job)draw(c.job.newValue)});
chrome.storage.session.get('job').then(x=>draw(x.job));
async function start(listen){
 if(workTab==='none'){el('toast').textContent='请从抖音原视频页点开拾句，再开始提取。';return}
 starting=true;draw(j);el('toast').textContent='';
 try{const tab=workTab?await chrome.tabs.get(Number(workTab)):(await chrome.tabs.query({active:true,currentWindow:true}))[0];const r=await chrome.runtime.sendMessage({to:'bg',op:'start',tab:tab.id,listen,force:el('force').checked});if(r?.error)throw Error(r.error)}
 catch(e){el('toast').textContent=e.message}finally{starting=false;draw(j)}
};
el('start').onclick=()=>start(false);el('listen').onclick=()=>start(true);
el('stop').onclick=()=>chrome.runtime.sendMessage({to:'bg',op:'stop',token:j.token});
el('raw').onclick=()=>{mode='raw';draw(j)};el('structure').onclick=()=>{mode='structure';draw(j)};
for(const [id,fn] of [['copyRaw',transcript],['copyScript',scriptText]])el(id).onclick=async()=>{try{await navigator.clipboard.writeText(fn(j));el('toast').textContent=id==='copyRaw'?'逐字稿已复制':'脚本拆解已复制'}catch{el('toast').textContent='复制失败，请选中预览文字复制'}};

el('sendClip').onclick=async()=>{
 const r=j?.rows[Number(el('clipRow').value)];if(!r)return;
 const btn=el('sendClip');btn.disabled=true;
 try{const ans=await chrome.runtime.sendMessage('hefjnoijenplmenpkfjholepppkdjjlp',{op:'offer-spoken-clip',clip:{id:j.workId,title:j.title,s:r.s,e:r.e,t:r.t}});
 if(!ans?.ok)throw Error(ans?.error||'未连接到选题夹');el('toast').textContent='请在打开的页面选择选题卡。'}
 catch(e){el('toast').textContent='未能打开选题夹。请确认当前 Chrome 已启用新版「评论区选题夹」。 '+(e.message||'')}
 finally{btn.disabled=false}
};

async function openComparison(fragment) {
 const base=chrome.runtime.getURL('compare.html');
 const url=base+'#'+fragment;
 try {
  await ShijuNav.remember();
  const contexts=await chrome.runtime.getContexts({contextTypes:['TAB']});
  const editor=contexts.find(ctx=>ctx.documentUrl?.split('#')[0]===base);
  if(editor){
   await chrome.tabs.update(editor.tabId,{url,active:true});
   if(editor.windowId>=0)await chrome.windows.update(editor.windowId,{focused:true});
  }else await chrome.tabs.create({url});
 } catch(e){el('toast').textContent='打开文案对比失败：'+e.message}
}
el('openCompare').onclick=()=>openComparison('step=compare');
el('openFinal').onclick=()=>openComparison('step=final');
el('compareJob').onclick=()=>{if(j?.rows.length)openComparison('job='+encodeURIComponent(j.token))};
el('syncMetrics').onclick=async()=>{
 const btn=el('syncMetrics');btn.disabled=true;el('toast').textContent='正在读取这条作品的数据…';
 try{
  const tab=workTab?await chrome.tabs.get(Number(workTab)):(await chrome.tabs.query({active:true,currentWindow:true}))[0];
  if(!/^https:\/\/(?:[\w-]+\.)*(?:douyin|iesdouyin)\.com\//.test(tab?.url||''))throw Error('请在对应的抖音原视频页面点开拾句。');
  const target={tabId:tab.id};
  await chrome.scripting.executeScript({target,files:['metrics.js']});
  const [r]=await chrome.scripting.executeScript({target,func:async()=>{
   const id=ShijuMetrics.workId();if(!id)return null;
   return {id,values:await ShijuMetrics.read(id)};
  }});
  const packet=r?.result;if(!packet||!Object.values(packet.values).some(Boolean))throw Error('这条作品没有读到可用数据，可以在对比表点「编辑数据」手填。');
  const key=crypto.randomUUID();await chrome.storage.session.set({['metrics:'+key]:packet});
  el('toast').textContent='已读取作品数据';await openComparison('metrics='+key);
 }catch(e){el('toast').textContent=e.message}finally{btn.disabled=false}
};

if(workTab==='none')el('lead').textContent='要提取新作品，请先打开抖音原视频，再点工具栏上的拾句。这里仍可查看上次逐字稿。';
