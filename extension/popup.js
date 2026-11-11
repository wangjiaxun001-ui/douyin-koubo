const el=id=>document.getElementById(id);let j,mode='raw',starting=false;
function draw(x){
 j=x;const busy=['probe','loading','listening','finishing'].includes(x?.phase);
 el('start').disabled=busy||starting;el('options').hidden=busy;el('job').hidden=!x;el('result').hidden=!x?.rows.length;if(!x)return;
 el('source').textContent=x.source||'读取作品';el('title').textContent=x.title;el('status').textContent=x.message;
 el('progress').textContent=x.duration?timeTag(x.time)+' / '+timeTag(x.duration):'';el('bar').value=x.duration?x.time/x.duration:0;
 el('stop').hidden=!busy||x.phase==='finishing';el('preview').textContent=x.rows.length?(mode==='raw'?transcript(x):scriptText(x)):'';
 el('raw').setAttribute('aria-pressed',mode==='raw');el('structure').setAttribute('aria-pressed',mode!=='raw')
}
chrome.storage.onChanged.addListener((c,area)=>{if(area==='session'&&c.job)draw(c.job.newValue)});
chrome.storage.session.get('job').then(x=>draw(x.job));
el('start').onclick=async()=>{
 starting=true;draw(j);el('toast').textContent='';
 try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const r=await chrome.runtime.sendMessage({to:'bg',op:'start',tab:tab.id,force:el('force').checked});if(r?.error)throw Error(r.error)}
 catch(e){el('toast').textContent=e.message}finally{starting=false;draw(j)}
};
el('stop').onclick=()=>chrome.runtime.sendMessage({to:'bg',op:'stop',token:j.token});
el('raw').onclick=()=>{mode='raw';draw(j)};el('structure').onclick=()=>{mode='structure';draw(j)};
for(const [id,fn] of [['copyRaw',transcript],['copyScript',scriptText]])el(id).onclick=async()=>{try{await navigator.clipboard.writeText(fn(j));el('toast').textContent=id==='copyRaw'?'逐字稿已复制':'脚本拆解已复制'}catch{el('toast').textContent='复制失败，请选中预览文字复制'}};
