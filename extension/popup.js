// Keep the transcript and segment selector open while visiting the destination card.
let workTab=new URLSearchParams(location.search).get('workTab');
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
 syncKakaJob(x?.token);
 j=x;const busy=['probe','loading','listening','fast','finishing'].includes(x?.phase);
 const another=busy && workTab && workTab!=='none' && String(x.tab)!==workTab;
 el('start').firstChild.textContent=starting?'正在连接视频… ':another?'另一条视频正在提取 ':busy?'正在提取，请稍候 ':workTab==='none'?'连接视频并提取 ':'快速提取当前视频 ';
 el('start').disabled=busy||starting;el('options').hidden=busy;el('job').hidden=!x;el('result').hidden=busy||!x?.rows.length;if(!x)return;
 el('source').textContent=x.source||'读取作品';el('title').textContent=x.title;el('status').textContent=(another?'正在处理另一条作品，完成后可提取当前视频。 ':'')+x.message;
 el('progress').textContent=x.duration?timeTag(x.time)+' / '+timeTag(x.duration):'';if(busy && ['probe','loading','finishing'].includes(x.phase))el('bar').removeAttribute('value');
 else el('bar').value=x.duration?x.time/x.duration:0;
 const link=el('openWork');
 link.hidden=!['error','partial','unavailable'].includes(x.phase)||busy||!/^\d{10,22}$/.test(x.workId||'');
 if(!link.hidden)link.href='https://www.douyin.com/video/'+x.workId;
 el('stop').hidden=!busy||x.phase==='finishing';el('preview').textContent=!busy&&x.rows.length?(mode==='raw'?transcript(x):scriptText(x)):'';
 const sel=el('clipRow'),rows=x.rows;
 if(sel.dataset.job!==x.token||sel.dataset.source!==x.source||sel.options.length>rows.length){
  sel.replaceChildren();sel.dataset.job=x.token;sel.dataset.source=x.source;
 }
 // Incoming progress must not collapse an open selector or reset the chosen sentence.
 for(let i=sel.options.length;i<rows.length;i++)sel.add(new Option(timeTag(rows[i].s)+'　'+rows[i].t,String(i)));
 el('sendClip').disabled=!/^\d{10,22}$/.test(x.workId||'')||!rows.length;
 el('clipHint').textContent=el('sendClip').disabled?'需要带来源的逐字稿，请在单条作品页重新提取。':'确认后只存原话和时间，不存视频。';
 el('raw').setAttribute('aria-pressed',mode==='raw');el('structure').setAttribute('aria-pressed',mode!=='raw')
}
chrome.storage.onChanged.addListener((c,area)=>{if(area==='session'&&c.job)draw(c.job.newValue)});
chrome.storage.session.get('job').then(x=>draw(x.job));
el('asrMode').value=localStorage.getItem('shiju-asr-mode')==='fast'?'fast':'precise';
el('asrMode').onchange=()=>localStorage.setItem('shiju-asr-mode',el('asrMode').value);
async function start(){
 starting=true;draw(j);el('toast').textContent='';
 try{const tab=await selectSource();if(!tab)return;const r=await chrome.runtime.sendMessage({to:'bg',op:'start',tab:tab.id,mode:el('asrMode').value,terms:el('asrTerms').value,force:el('force').checked});if(r?.error)throw Error(r.error)}
 catch(e){el('toast').textContent=e.message}finally{starting=false;draw(j)}
};
el('start').onclick=start;
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
  const tab=await selectSource();if(!tab)return;
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

const douyinOrigin='https://www.douyin.com/*';
function showDisconnected(){
 workTab='none';
 el('lead').textContent='先在本窗口打开要提取的抖音作品，再回来连接视频。';
 el('start').firstChild.textContent='连接视频并提取 ';
 el('openDouyin').hidden=false;
}
async function selectSource(){
 if(workTab!=='none'){
  const tab=workTab ? await chrome.tabs.get(Number(workTab)).catch(()=>null)
                    : (await chrome.tabs.query({active:true,currentWindow:true}))[0];
  if(ShijuNav.sourceUrl(tab?.url))return tab;
  showDisconnected();
 }
 // Only request the Douyin origin when the user reconnects from a standalone workspace.
 const allowed=await chrome.permissions.request({origins:[douyinOrigin]});
 if(!allowed)throw Error('要连接已打开的视频，请允许访问抖音，或在原视频页点击工具栏里的拾句。');
 const tabs=await chrome.tabs.query({url:douyinOrigin,currentWindow:true});
 const select=el('sourceTabs'), preferred=select.value;
 let tab=tabs.find(t=>String(t.id)===preferred);
 if(!tab && tabs.length===1)tab=tabs[0];
 if(!tab){
  select.replaceChildren(new Option('请选择作品',''), ...tabs.map(t=>new Option(t.title||t.url,String(t.id))));
  el('sourceTools').hidden=!tabs.length;
  el('toast').textContent=tabs.length?'请选择要处理的抖音标签页，再点一次按钮。':'本窗口还没有打开抖音作品。点「打开抖音」，进入视频后回来重试。';
  return null;
 }
 workTab=String(tab.id);
 history.replaceState(null,'','?workTab='+workTab);
 el('sourceTools').hidden=true;el('openDouyin').hidden=true;
 el('lead').textContent='已连接：'+(tab.title||tab.url);
 el('start').firstChild.textContent='快速提取当前视频 ';
 return tab;
}
if(workTab==='none')showDisconnected();
else if(workTab)chrome.tabs.get(Number(workTab)).then(tab=>{
 if(!ShijuNav.sourceUrl(tab.url))showDisconnected();
}).catch(showDisconnected);
