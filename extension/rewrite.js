'use strict';

const rewriteProviders = {
  DeepSeek: {origin:'https://api.deepseek.com', path:'/chat/completions', model:'deepseek-flash'},
  Gemini: {origin:'https://generativelanguage.googleapis.com', model:'gemini-3.5-flash'},
  '豆包': {origin:'https://ark.cn-beijing.volces.com', path:'/api/v3/chat/completions', model:'doubao-seed-2-1-pro-260915'}
};
let rewriteRequest;
const rewriteToggleKey = 'shiju-rewrite-enabled';
const rewriteGuide = '你是中文短视频口播编辑。请根据提供的原稿和修改要求改写成一篇可以直接说出口的完整口播稿。保留原稿的观点、事实和个人语气，不虚构经历或数字。只输出改稿正文，按自然段换行。';

function refreshRewriteControls() {
  const hasDraft = !!project.raw[Number($('ai-source').value)]?.trim();
  $('ai-panel').hidden = !$('ai-toggle').checked;
  $('ai-generate').disabled = !hasDraft || !!rewriteRequest;
  $('ai-copy').disabled = !hasDraft;
}
function refreshRewriteSources() {
  const select = $('ai-source');
  const saved = select.value;
  select.replaceChildren(...project.names.map((name,i)=>new Option(name,String(i))));
  if (saved && Number(saved)<project.names.length) select.value = saved;
  refreshRewriteControls();
}
function resetRewrite() {
  rewriteRequest?.abort();
  rewriteRequest = null;
  $('ai-status').textContent = '';
  $('ai-source').selectedIndex = 0;
  $('ai-instruction').value = '';
}
function rewriteInput() {
  return '修改要求：'+($('ai-instruction').value.trim() || '让表达更自然、清楚，适合口播。')+'\n\n原稿：\n'+project.raw[Number($('ai-source').value)].trim();
}

function makeRewriteRequest(provider, model, key, input) {
  const config = rewriteProviders[provider];
  const headers = {'Content-Type':'application/json'};
  if (provider==='Gemini') {
    headers['x-goog-api-key'] = key;
    return {url:config.origin+'/v1beta/models/'+encodeURIComponent(model)+':generateContent', headers,
      body:{systemInstruction:{parts:[{text:rewriteGuide}]},contents:[{role:'user',parts:[{text:input}]}]}};
  }
  headers.Authorization = 'Bearer '+key;
  return {url:config.origin+config.path, headers,
    body:{model,messages:[{role:'system',content:rewriteGuide},{role:'user',content:input}]}};
}
function extractRewrite(provider, data) {
  if (provider==='Gemini') {
    const answer=data.candidates?.[0];
    if (answer?.finishReason==='STOP') return answer.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('').trim();
  } else {
    const answer=data.choices?.[0];
    if (answer?.finish_reason==='stop' && typeof answer.message?.content==='string') return answer.message.content.trim();
  }
  return '';
}
function addRewrite(provider, text, base) {
  // Reuse an untouched, named provider column in older projects. Edited columns are kept as versions.
  let col=project.names.findIndex((name,i)=>i!==base && name===provider && !project.raw[i] && !project.imported[i]
    && !project.sources[i] && !Object.entries(project.cells).some(([k,v])=>k.startsWith(i+'/') && v)
    && !project.order.some(k=>k.startsWith(i+'/')) && !Object.values(project.metrics?.[i]?.values||{}).some(Boolean));
  if (col<0) {
    let name=provider, version=1;
    while(project.names.includes(name)) name=provider+' 改稿 '+(++version);
    appendSource(name,text,'');
    col=project.names.length-1;
  } else {
    project.raw[col]=text;
    placeDraft(col,text);
  }
  renderSources();renderTable();renderQueue();refreshImport();save();
  return project.names[col];
}
async function generateRewrite() {
  if (!$('ai-toggle').checked || rewriteRequest) return;
  const provider=$('ai-provider').value, key=$('ai-key').value.trim(), model=$('ai-model').value.trim();
  const base=Number($('ai-source').value), raw=project.raw[base], instruction=$('ai-instruction').value;
  if (!raw?.trim()) return;
  if (!key || !model) {
    $('ai-status').textContent='请填写所选服务的 API Key 和模型 ID，或复制提示词到 AI 网页。';
    $(key?'ai-model':'ai-key').focus();return;
  }
  const request=makeRewriteRequest(provider,model,key,rewriteInput());
  const controller=new AbortController();
  rewriteRequest=controller;
  refreshRewriteControls();
  $('ai-status').textContent=provider+' 正在修改原稿…';
  const timer=setTimeout(()=>controller.abort(),120000);
  try {
    if (globalThis.chrome?.permissions && location.protocol==='chrome-extension:') {
      const granted=await chrome.permissions.request({origins:[rewriteProviders[provider].origin+'/*']});
      if (!granted) throw Error('需要允许拾句连接所选服务才能生成改稿。');
    }
    controller.signal.throwIfAborted();
    const response=await fetch(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(request.body),
      signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'});
    if (!response.ok) {
      const details={400:'请检查模型 ID 和原稿长度',401:'请检查 API Key',403:'请检查 API Key 和模型权限',404:'请检查模型 ID',429:'请检查额度或稍后再试'};
      throw Error(provider+' 返回 '+response.status+'，'+(details[response.status]||'请稍后再试')+'。');
    }
    const text=extractRewrite(provider,await response.json());
    if (rewriteRequest!==controller || controller.signal.aborted) return;
    if (project.raw[base]!==raw || $('ai-instruction').value!==instruction) throw Error('原稿或要求已修改，请按新内容重新生成。');
    if (!text) throw Error('服务没有返回完整改稿，请调整要求后重试。');
    const name=addRewrite(provider,text,base);
    $('ai-status').textContent='改稿已加入「'+name+'」，可以继续编辑或分段对比。';
  } catch(error) {
    if (rewriteRequest===controller) $('ai-status').textContent=controller.signal.aborted?'请求超时，请重试。':error instanceof TypeError?'连接失败，请检查网络后重试。':error.message;
  } finally {
    clearTimeout(timer);
    if(rewriteRequest===controller){rewriteRequest=null;refreshRewriteControls()}
  }
}

function initRewrite() {
  $('ai-toggle').checked=localStorage.getItem(rewriteToggleKey)==='on';
  $('ai-model').value=rewriteProviders.DeepSeek.model;
  $('ai-toggle').onchange=()=>{
    if (!$('ai-toggle').checked) {
      rewriteRequest?.abort();rewriteRequest=null;$('ai-status').textContent='';$('ai-key').value='';
    }
    refreshRewriteControls();
    try{localStorage.setItem(rewriteToggleKey,$('ai-toggle').checked?'on':'off')}catch{}
  };
  $('ai-provider').onchange=()=>{
    rewriteRequest?.abort();rewriteRequest=null;$('ai-key').value='';
    $('ai-model').value=rewriteProviders[$('ai-provider').value].model;
    $('ai-status').textContent='';refreshRewriteControls();
  };
  $('ai-source').onchange=()=>{
    rewriteRequest?.abort();rewriteRequest=null;$('ai-status').textContent='';refreshRewriteControls();
  };
  $('ai-generate').onclick=generateRewrite;
  $('ai-copy').onclick=async()=>{
    try{await navigator.clipboard.writeText(rewriteGuide+'\n\n'+rewriteInput());$('ai-status').textContent='已复制原稿和修改要求，可粘贴到 AI 对话框。'}
    catch{$('ai-status').textContent='浏览器未允许复制，请检查剪贴板权限。'}
  };
}
