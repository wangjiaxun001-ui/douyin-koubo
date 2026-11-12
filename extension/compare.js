
'use strict';
const defaultNames = ['我的原稿', 'DeepSeek', 'Gemini', '豆包'];
const groups = ['开头', '中间', '结尾'];
const storage = 'shiju-script-editor.v1';
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID();
const metricLabels={fans:'粉丝',likes:'点赞',comments:'评论'};
function stats(p,col){
 p.metrics??=[];return p.metrics[col]??={values:{},manual:{}};
}
function applyMetrics(p,col,values,at=Date.now(),seed=false){
 const m=stats(p,col);
 for(const k of ShijuMetrics.keys){
  const value=ShijuMetrics.count(values?.[k]);
  m.checked??={};
  if(value&&(!seed||!m.checked[k])&&(!m.checked[k]||m.checked[k]<=at)){
   m.values[k]=value;m.manual[k]=false;m.checked[k]=at;
  }
 }
}
$('return-extract').onclick=async()=>{try{await ShijuNav.back()}catch{$('sync-state').textContent='返回失败，请从原视频页重新打开拾句。'}};
const localSnapshots=globalThis.chrome?.runtime?.getURL ? fetch(chrome.runtime.getURL('local-snapshots.json')).then(r=>r.ok?r.json():{}).catch(()=>({})):Promise.resolve({});
const steps=['intake','compare','draft','final'];
function highlight(id){for(const b of document.querySelectorAll('[data-step]')){
 if(b.dataset.step===id)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');
}}
function go(id){
 if(!steps.includes(id))return;
 if(id==='intake')$('intake').open=true;
 $(id).scrollIntoView({block:'start'});highlight(id);
}
for(const b of document.querySelectorAll('[data-step]'))b.onclick=()=>go(b.dataset.step);
let scheduled=false;
window.addEventListener('scroll',()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{
 scheduled=false;const y=document.querySelector('.workflow').getBoundingClientRect().height+24;
 highlight(window.scrollY>0&&window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2?'final':steps.filter(id=>$(id).getBoundingClientRect().top<=y).at(-1)||'intake');
})},{passive:true});
function newProject(names=defaultNames) {
  return {id:uid(), title:'', filename:'', names:[...names], sources:[], finalText:'', generatedFrom:null, raw:names.map(()=>''), imported:names.map(()=>''),
    cells:{}, order:[], middles:1};
}
let library;
try { library = JSON.parse(localStorage.getItem(storage)); } catch {}
if (!library?.projects?.length) {
  const first = newProject();
  library = {active:first.id, projects:[first]};
}
let project = library.projects.find(item => item.id === library.active) || library.projects[0];
let filter = '全部';
function save() {
  try { localStorage.setItem(storage, JSON.stringify(library)); $('save-state').textContent='已暂存在当前浏览器'; }
  catch { $('save-state').textContent='当前浏览器无法暂存，请及时下载逐字稿'; }
}
function node(tag, text) {
  const element=document.createElement(tag);
  if(text !== undefined) element.textContent=text;
  return element;
}
function button(text, action) {
  const b=node('button',text); b.type='button'; b.onclick=action; return b;
}
function sourceKey(col, group, index=0) { return [col,group,index].join('/'); }
function rowName(key) {
  const [,group,index] = key.split('/');
  return group==='中间' ? '中间 '+(Number(index)+1) : group;
}
function splitDraft(raw) {
  const result={'开头':[], '中间':[], '结尾':[]};
  const lines=raw.replace(/\r\n?/g,'\n').split('\n');
  const marker=/^\s*(?:#{1,4}\s*|【|\[)?(开头|中间|正文|结尾)(?:[】\]]\s*[:：]?\s*|\s*[:：]\s*|\s*$)(.*)$/;
  if(lines.some(line=>marker.test(line))) {
    let group='开头';
    for(const line of lines) {
      const match=line.match(marker);
      if(match){group=match[1]==='正文'?'中间':match[1];if(match[2].trim())result[group].push(match[2].trim());}
      else if(line.trim())result[group].push(line.trim());
    }
  } else {
    let parts=lines.map(line=>line.trim()).filter(Boolean);
    if(parts.length===1)parts=parts[0].match(/[^。！？!?]+(?:[。！？!?]+[”’」』）)]*)?|[。！？!?]+/g)?.map(s=>s.trim()).filter(Boolean)||parts;
    if(parts.length)result['开头']=[parts.shift()];
    if(parts.length)result['结尾']=[parts.pop()];
    result['中间']=parts;
  }
  return result;
}
function placeDraft(col, raw) {
  project.beforeSort=null;
  for(const key of Object.keys(project.cells))if(key.startsWith(col+'/'))delete project.cells[key];
  project.order=project.order.filter(key=>!key.startsWith(col+'/'));
  const parts=splitDraft(raw);
  for(const group of groups){
    const pieces=group==='中间'?parts[group]:[parts[group].join('\n')];
    pieces.forEach((text,i)=>project.cells[sourceKey(col,group,i)]=text);
  }
  project.middles=Math.max(project.middles,parts['中间'].length);
  project.imported[col]=raw;
}
function refreshProjects(){
  $('projects').replaceChildren();
  library.projects.forEach((p,i)=>{
    const option=node('option',p.title.trim() || '未命名选题 '+(i+1));
    option.value=p.id; option.selected=p===project; $('projects').append(option);
  });
}
function refreshImport(){
  $('import').disabled=!project.raw.some((v,i)=>v.trim() && v!==project.imported[i]);
}
// Match the matrix: read each row from left to right, then move down.
function byTablePosition(a,b){
 const [ac,ag,ai]=a.split('/'),[bc,bg,bi]=b.split('/');
 return groups.indexOf(ag)-groups.indexOf(bg)||Number(ai)-Number(bi)||Number(ac)-Number(bc);
}
function useTableOrder(p){
 const before=p.order.slice();p.order.sort(byTablePosition);p.orderMode='table';
 p.beforeSort=before.some((key,i)=>key!==p.order[i])?before:null;
}
function activate(p){
 if(!p.orderMode)useTableOrder(p);
  project=p; library.active=p.id; filter='全部';highlight('intake');
  document.title=(p.title || '未命名选题')+' · 文案对比与成稿';
  renderSources(); $('final-text').value=p.finalText || '';
  refreshProjects(); $('topic').value=p.title; $('filename').value=p.filename;
  $('filename').placeholder=(p.title.trim()||'新选题')+'-逐字稿';
  for(const [i,area] of [...$('inputs').querySelectorAll('textarea')].entries())area.value=p.raw[i];
  $('intake').open=!Object.values(p.cells).some(Boolean)||p.raw.some((v,i)=>v.trim()&&v!==p.imported[i]);
  refreshImport(); renderTable(); renderQueue(); save();
}
function exportText(){
  return project.order.map(key=>(project.cells[key]||'').trim()).filter(Boolean).join('\n\n');
}
function editor(key, label, kind){
  const area=node('textarea'); area.className='editor'; area.dataset[kind]=key;
  area.setAttribute('aria-label',label); area.rows=3; area.value=project.cells[key]||'';
  area.placeholder='在这里填写'+rowName(key);
  area.oninput=()=>{
    project.cells[key]=area.value;
    const other=document.querySelector('[data-'+(kind==='cell'?'draft':'cell')+'="'+key+'"]');
    if(other)other.value=area.value;
    updateFinalControls(); save();
  };
  return area;
}
function renderTable(){
  const body=$('matrix');body.replaceChildren();
  const columns=[...$('filters').children];
  columns.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.group===filter)));
  const rows=[['开头',0],...Array.from({length:project.middles},(_,i)=>['中间',i]),['结尾',0]];
  for(const [group,i] of rows){
    if(filter!=='全部'&&filter!==group)continue;
    const row=body.insertRow();
    const th=node('th',rowName(sourceKey(0,group,i)));th.scope='row';row.append(th);
    project.names.forEach((name,col)=>{
      const key=sourceKey(col,group,i), cell=row.insertCell(), label=node('label'), box=node('input');
      label.className='select';box.type='checkbox';box.dataset.pick=key;box.checked=project.order.includes(key);
      box.onchange=()=>{
        project.order=project.order.filter(k=>k!==key);
        project.beforeSort=null;
        if(box.checked){project.order.push(key);if(project.orderMode==='table')project.order.sort(byTablePosition)}
        if(!project.order.length)project.orderMode='table';
        renderQueue();save();
      };
      label.append(box,' 选用');cell.append(label,editor(key,name+' '+rowName(key),'cell'));
    });
  }
}
function removePick(key){
  project.beforeSort=null;
  project.order=project.order.filter(k=>k!==key);
  if(!project.order.length)project.orderMode='table';
  const box=document.querySelector('[data-pick="'+key+'"]');if(box)box.checked=false;
  renderQueue();save();
}
function movePick(i,delta){
  project.orderMode='manual';project.beforeSort=null;
  const j=i+delta;[project.order[i],project.order[j]]=[project.order[j],project.order[i]];
  renderQueue();save();
}
$('table-order').onclick=()=>{useTableOrder(project);renderQueue();save()};
$('undo-order').onclick=()=>{
 if(!project.beforeSort)return;project.order=project.beforeSort;project.beforeSort=null;project.orderMode='manual';renderQueue();save();
};
function renderQueue(){
 $('order-hint').textContent=project.orderMode==='manual'?'已手动排序。新选的段落会加在末尾。':'与上表顺序一致：开头 → 中间 → 结尾，同一行从左到右。';
 $('table-order').hidden=project.orderMode!=='manual'||!project.order.length;
 $('undo-order').hidden=!project.beforeSort;
  const list=$('queue');list.replaceChildren();
  project.order.forEach((key,i)=>{
    const li=node('li'), head=node('div'), label=project.names[Number(key.split('/')[0])]+' · '+rowName(key);
    head.className='rowhead';
    const up=button('上移',()=>movePick(i,-1)),down=button('下移',()=>movePick(i,1));
    up.disabled=i===0;down.disabled=i===project.order.length-1;
    head.append(node('strong',label),up,down,button('移除',()=>removePick(key)));
    li.append(head,editor(key,'成稿 '+label,'draft'));list.append(li);
  });
  $('empty').hidden=!!project.order.length;updateFinalControls();
}
function renderSources(){
  $('inputs').replaceChildren(); $('head').replaceChildren(node('th','段落'));
  $('cols').replaceChildren(...Array.from({length:project.names.length+1},()=>node('col')));
  $('matrix').closest('table').style.minWidth=(78+225*project.names.length)+'px';
  project.names.forEach((name,col)=>{
    const label=node('div'), nameInput=node('input'), area=node('textarea');
    nameInput.className='source-name';nameInput.type='text';nameInput.value=name;nameInput.setAttribute('aria-label','第 '+(col+1)+' 篇名称');
    area.value=project.raw[col];area.setAttribute('aria-label',name+' 全文');area.placeholder='粘贴全文';
    const th=node('th'),caption=node('span',name);th.scope='col';th.append(caption);
    const url=project.sources[col];
    if(url && /^https:\/\/www\.douyin\.com\/video\/\d+$/.test(url)){const a=node('a','原视频 ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';th.append(a)}
    nameInput.onchange=()=>{project.names[col]=nameInput.value.trim()||'文案 '+(col+1);nameInput.value=project.names[col];caption.textContent=nameInput.value;area.setAttribute('aria-label',nameInput.value+' 全文');renderTable();renderQueue();save()};
    area.oninput=()=>{project.raw[col]=area.value;refreshImport();save()};
    const m=stats(project,col), fields=node('div'), strip=node('div');fields.className='metric-inputs';strip.className='metric-strip';
    for(const k of ShijuMetrics.keys){
     const tag=node('label',metricLabels[k]),input=node('input'),badge=node('span');
     input.type='text';input.placeholder='未获取';input.value=m.values[k]||'';
     input.setAttribute('aria-label','第 '+(col+1)+' 篇'+metricLabels[k]+'数');
     const paint=()=>{badge.textContent=metricLabels[k]+' '+(m.values[k]||'—');badge.title=m.values[k]?(m.manual[k]?'手动填写':('抖音原页'+(m.checked?.[k]?' · '+new Date(m.checked[k]).toLocaleString('zh-CN'):''))):'未读到原页数据';if(m.manual[k])badge.textContent+='（手填）';badge.dataset.metric=k};
     paint();input.oninput=()=>{
      const raw=input.value.trim(),value=ShijuMetrics.count(raw);
      if(raw&&!value){input.setCustomValidity('请输入非负整数或 1.2万 这样的数量');input.reportValidity();return}
      input.setCustomValidity('');if(m.checked)delete m.checked[k];m.values[k]=value;m.manual[k]=!!value;paint();save();
     };input.onblur=()=>{if(!input.validity.valid){input.value=m.values[k]||'';input.setCustomValidity('')}};
     tag.append(input);fields.append(tag);strip.append(badge);
    }
    if(url){
     const note=node('small',ShijuMetrics.keys.some(k=>!m.values[k])?'部分数据未核实':'');note.className='check-note';th.append(strip,note);
    }
    const edit=button('编辑数据',()=>{go('intake');fields.querySelector('input').focus()});edit.className='edit-metrics';if(!url)th.append(strip);th.append(edit);
    label.append(nameInput,fields,area);$('inputs').append(label);$('head').append(th)
  });
}
function updateFinalControls(){
 const assembled=exportText(),text=project.finalText||'';
 $('generate').disabled=!assembled;$('download').disabled=!text.trim();$('copy-final').disabled=!text.trim();
 $('final-state').textContent=project.generatedFrom!==null && project.generatedFrom!==assembled?'已选段落有变化，重新生成可更新最终文案。':'';
}
$('generate').onclick=()=>{
 const assembled=exportText();if(!assembled)return;
 if(project.finalText && project.finalText!==project.generatedFrom && !confirm('用当前已选段落替换手动编辑的最终文案？'))return;
 project.finalText=assembled;project.generatedFrom=assembled;$('final-text').value=assembled;updateFinalControls();save();go('final');$('final-text').focus({preventScroll:true})
};
$('final-text').oninput=e=>{project.finalText=e.target.value;updateFinalControls();save()};
$('copy-final').onclick=async()=>{try{await navigator.clipboard.writeText(project.finalText);$('final-state').textContent='最终文案已复制'}catch{$('final-text').select();$('final-state').textContent='已选中全文，请按复制快捷键'}};
$('add-source').onclick=()=>{appendSource('文案 '+(project.names.length+1),'','');renderSources();renderTable();save();$('inputs').lastElementChild.querySelector('input').focus()};
function appendSource(name,text,url){
 const col=project.names.length;project.names.push(name);project.raw.push(text);project.imported.push('');project.sources[col]=url;
 if(text)placeDraft(col,text);
}
for(const group of ['全部',...groups]){
  const b=button(group==='全部'?'看全部':'只看'+group,()=>{filter=group;renderTable();});
  b.dataset.group=group;$('filters').append(b);
}
$('topic').oninput=e=>{project.title=e.target.value;refreshProjects();$('filename').placeholder=(project.title.trim()||'新选题')+'-逐字稿';save();};
$('filename').oninput=e=>{project.filename=e.target.value;save();};
$('new-project').onclick=()=>{const fresh=newProject();library.projects.push(fresh);activate(fresh);$('topic').focus();};
$('delete-project').onclick=()=>{
  const select=$('projects');
  const id=select.value;
  const name=select.selectedOptions[0]?.textContent;
  if(!name||!confirm('删除「'+name+'」？这会一并删除该选题的来源文案、已选段落和最终稿。'))return;
  try{
    const saved=localStorage.getItem(storage);
    const latest=saved?JSON.parse(saved):structuredClone(library);
    const index=latest.projects.findIndex(item=>item.id===id);
    if(index>=0)latest.projects.splice(index,1);
    if(!latest.projects.length)latest.projects.push(newProject());
    const next=latest.projects[Math.max(0,Math.min(index,latest.projects.length-1))];
    latest.active=next.id;
    localStorage.setItem(storage,JSON.stringify(latest));
    library=latest;
    activate(next);
    select.focus();
  }catch{
    $('save-state').textContent='删除未完成，请刷新后重试。';
  }
};
$('projects').onchange=e=>activate(library.projects.find(p=>p.id===e.target.value));
$('import').onclick=()=>{
  const changed=project.names.map((_,i)=>i).filter(i=>project.raw[i].trim()&&project.raw[i]!==project.imported[i]);
  const replace=changed.filter(i=>Object.keys(project.cells).some(k=>k.startsWith(i+'/')&&project.cells[k])||project.order.some(k=>k.startsWith(i+'/')));
  if(replace.length&&!confirm('重新分段会替换 '+replace.map(i=>project.names[i]).join('、')+' 栏的编辑内容，并移除这些栏的已选段落。继续吗？'))return;
  changed.forEach(i=>placeDraft(i,project.raw[i]));filter='全部';renderTable();renderQueue();refreshImport();save();$('intake').open=false;go('compare');
};
$('add-middle').onclick=()=>{project.middles++;filter='中间';renderTable();save();$('matrix').lastElementChild.querySelector('textarea').focus();};
$('download').onclick=()=>{
  const text=project.finalText;if(!text.trim())return;
  const title=(project.filename.trim()||(project.title.trim()||'新选题')+'-逐字稿').replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').replace(/\.txt$/i,'')||'逐字稿';
  const url=URL.createObjectURL(new Blob([text+'\n'],{type:'text/plain;charset=utf-8'}));
  const link=node('a');link.href=url;link.download=title+'.txt';document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
};
async function loadEditor(){
 const saved=localStorage.getItem(storage);
 if(saved){const latest=JSON.parse(saved);if(latest.projects?.length){library=latest;project=library.projects.find(p=>p.id===library.active)||library.projects[0]}}
 const params=new URLSearchParams(location.hash.slice(1));
 const token=params.get('job');
 if(params.has('project')){
   const payload=JSON.parse(params.get('project'));
   if(typeof payload.id!=='string'||typeof payload.title!=='string'||!Array.isArray(payload.drafts)||!payload.drafts.length||payload.drafts.some(d=>typeof d.name!=='string'||typeof d.text!=='string'))throw Error('文案数据不完整');
   const existing=library.projects.find(p=>p.id===payload.id);
   if(existing)project=existing;
   else{
    project=newProject([]);project.id=payload.id;project.title=payload.title;
    library.projects.push(project);
    for(const d of payload.drafts){appendSource(d.name,d.text,d.url||'');applyMetrics(project,project.names.length-1,d.metrics)}
   }
 }
 if(token && globalThis.chrome?.storage?.session){
   const {job}=await chrome.storage.session.get('job');
   if(job?.token===token && job.rows?.length){
    const url=/^\d+$/.test(job.workId)?'https://www.douyin.com/video/'+job.workId:'';
    const text=job.rows.map(row=>row.t).join('\n');
    let col=project.raw.findIndex((raw,i)=>raw===text&&project.sources[i]===url);
    if(col===-1){appendSource(job.title||'拾句口播',text,url);col=project.names.length-1}
    applyMetrics(project,col,job.metrics,job.metricsAt||Date.now());
   }
 }
 const sync=params.get('metrics');
 if(sync&&globalThis.chrome?.storage?.session){
  const key='metrics:'+sync;
  const packet=(await chrome.storage.session.get(key))[key];
  if(packet&&/^\d+$/.test(packet.id)){
   const url='https://www.douyin.com/video/'+packet.id;let hits=0;
   for(const p of library.projects)p.sources.forEach((source,i)=>{if(source===url){applyMetrics(p,i,packet.values);hits++}});
   $('sync-state').textContent=hits?'已匹配 '+hits+' 篇来源文案，已用抖音原页的数据更新对应栏。':'当前文案库里还没有这条作品。请先提取后点「把整篇加入文案对比」。';
   await chrome.storage.session.remove(key);
  }
 }
 // Restoring a saved comparison can reuse a completed lookup without visiting Douyin.
 if(globalThis.chrome?.storage?.session){
  const {job:cached}=await chrome.storage.session.get('job');
  if(cached?.metricsAt&&cached.workId)for(const p of library.projects)p.sources.forEach((source,col)=>{
   if(source==='https://www.douyin.com/video/'+cached.workId)applyMetrics(p,col,cached.metrics,cached.metricsAt);
  });
 }
 const baseline=await localSnapshots;
 for(const p of library.projects)p.sources.forEach((url,i)=>{
  const id=/^https:\/\/www\.douyin\.com\/video\/(\d+)$/.exec(url)?.[1],entry=baseline[id];
  if(entry){const m=stats(p,i);if(m.seedId===id)return;applyMetrics(p,i,entry.values,entry.at,true);m.seedId=id}
 });
 activate(project);
 const target=params.get('step')||(token||sync?'compare':null);
 if(steps.includes(target))requestAnimationFrame(()=>go(target));
 if(params.size)history.replaceState(null,'',location.pathname);
}
window.addEventListener('hashchange',()=>{if(/^#(?:job|step|metrics)=/.test(location.hash))loadEditor().catch(err=>{$('save-state').textContent=err.message})});
loadEditor().catch(err=>{activate(project);$('save-state').textContent='打开文案失败：'+err.message});

globalThis.chrome?.storage?.onChanged?.addListener((changes,area)=>{
 const job=changes.job?.newValue;if(area!=='session'||!job?.metricsAt||job.metricsAt===changes.job?.oldValue?.metricsAt)return;
 const url='https://www.douyin.com/video/'+job.workId;
 for(const p of library.projects)p.sources.forEach((source,col)=>{
  if(source!==url)return;applyMetrics(p,col,job.metrics,job.metricsAt);
  if(p===project){
   const m=stats(p,col),head=$('head').children[col+1],fields=$('inputs').children[col]?.querySelectorAll('.metric-inputs input');
   ShijuMetrics.keys.forEach((k,i)=>{if(!ShijuMetrics.count(job.metrics[k]))return;
    const badge=head?.querySelector('[data-metric="'+k+'"]');if(badge){badge.textContent=metricLabels[k]+' '+m.values[k];badge.title='抖音原页 · '+new Date(m.checked[k]).toLocaleString('zh-CN')}
    if(fields?.[i]&&document.activeElement!==fields[i])fields[i].value=m.values[k];
   });
   const note=head?.querySelector('.check-note');if(note&&ShijuMetrics.keys.every(k=>m.values[k]))note.textContent='';
  }
 });save();
});
