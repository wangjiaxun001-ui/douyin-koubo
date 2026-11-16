// The original job is read-only. Edits belong to a separate subtitle draft.
const kakaElement = id => document.getElementById(id);
let kakaToken, kakaDraft, kakaRequest;

function syncKakaJob(token) {
  if (token === kakaToken) return;
  kakaToken = token;
  kakaRequest?.abort();
  kakaDraft = null;
  kakaElement('kakaKey').value = '';
  kakaElement('kakaLines').replaceChildren();
  kakaElement('kakaPanel').hidden = true;
  kakaElement('kakaActions').hidden = true;
  kakaElement('kakaOpen').disabled = false;
  kakaElement('kakaCorrect').disabled = false;
  if (token && sessionStorage.getItem('kakaResume') === token) {
    sessionStorage.removeItem('kakaResume');
    queueMicrotask(() => openKaka(true));
  }
}

function kakaStatus(message) {
  kakaElement('kakaStatus').textContent = message;
}

async function saveKakaDraft(draft) {
  try { await chrome.storage.session.set({kakaDraft: draft}); }
  catch { if (draft === kakaDraft) kakaStatus('这次校对未能暂存，请先复制或导出。'); }
}

function renderKakaLines(draft) {
  const fields = draft.rows.map((row, index) => {
    const label = document.createElement('label');
    const stamp = document.createElement('small');
    stamp.textContent = timeTag(row.s / 1000);
    const field = document.createElement('textarea');
    field.rows = 1;
    field.value = row.t;
    field.setAttribute('aria-label', '第 ' + (index + 1) + ' 句字幕');
    field.oninput = () => {
      row.t = field.value;
      draft.revision++;
      saveKakaDraft(draft);
    };
    label.append(stamp, field);
    return label;
  });
  kakaElement('kakaLines').replaceChildren(...fields);
  kakaElement('kakaActions').hidden = false;
}

async function openKaka(resumed = false) {
  const token = kakaToken;
  if (!token || !j?.rows.length) return;
  const panel = kakaElement('kakaPanel');
  if (kakaDraft) { panel.hidden = !panel.hidden; return; }
  panel.hidden = false;
  kakaElement('kakaOpen').disabled = true;
  kakaStatus('正在打开本机卡卡字幕助手…');
  try {
    const granted = resumed || await chrome.permissions.request({permissions:['nativeMessaging']});
    if (!granted) throw Error('连接本机卡卡需要允许 Chrome 与本机应用通信。');
    // Chrome exposes the native bindings to a fresh extension page after the
    // optional permission is first granted. Resume the same completed job once.
    if (typeof chrome.runtime.sendNativeMessage !== 'function') {
      if (resumed) throw Error('Chrome 尚未启用本机通信，请重新加载拾句。');
      sessionStorage.setItem('kakaResume', token);
      location.reload();
      return;
    }
    const {kakaDraft: cached} = await chrome.storage.session.get('kakaDraft');
    if (token !== kakaToken) return;
    if (cached?.token === token && (cached.aligned || cached.revision > 0)) {
      kakaDraft = cached;
    } else {
      const answer = await chrome.runtime.sendNativeMessage('cn.shiju.videocaptioner', {op:'split', rows:j.rows});
      if (token !== kakaToken) return;
      if (answer?.error) throw Error(answer.error);
      if (!answer?.rows?.length) throw Error('这篇逐字稿没有可处理的字幕。');
      kakaDraft = {token, aligned:true, rows:answer.rows, prompt:answer.prompt, revision:0};
      await saveKakaDraft(kakaDraft);
      if (token !== kakaToken) return;
    }
    renderKakaLines(kakaDraft);
    const timing = !kakaDraft.aligned ? '已保留上次手动校对稿。' :
      j.source === '网页字幕' ? '已保留原字幕的分行和时间。' :
      j.source === '画面字幕' ? '已按画面字幕换行，换行时间精度约为 0.3 秒。' :
      j.source === '原声精校' ? '已按原声的停顿和标点断句。' : '已保留识别到的语音段时间。';
    kakaStatus('共 ' + kakaDraft.rows.length + ' 句。' + timing);
  } catch (error) {
    if (token === kakaToken) kakaStatus(/native messaging host|native host/i.test(error.message)
      ? '未能连接本机卡卡字幕助手。' + error.message : error.message);
  } finally { if (token === kakaToken) kakaElement('kakaOpen').disabled = false; }
}
kakaElement('kakaOpen').onclick = () => openKaka();

kakaElement('kakaCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(kakaDraft.rows.map(row => row.t.trim()).filter(Boolean).join('\n'));
    kakaStatus('已复制校对稿，只有文字。');
  } catch { kakaStatus('复制失败，请检查剪贴板权限。'); }
};

function subtitleTime(ms) {
  const pad = value => String(value).padStart(2, '0');
  return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor(ms / 60000) % 60) +
    ':' + pad(Math.floor(ms / 1000) % 60) + ',' + String(ms % 1000).padStart(3, '0');
}

kakaElement('kakaExport').onclick = () => {
  const lines = kakaDraft.rows.filter(row => row.t.trim());
  if (!lines.length) { kakaStatus('请先填写字幕文字。'); return; }
  const srt = lines.map((row, i) => [i + 1, subtitleTime(row.s) + ' --> ' + subtitleTime(row.e), row.t.trim()].join('\r\n')).join('\r\n\r\n');
  const url = URL.createObjectURL(new Blob([srt + '\r\n'], {type:'application/x-subrip;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = '拾句字幕-' + (j.workId || '口播') + '.srt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

kakaElement('kakaCorrect').onclick = async () => {
  const draft = kakaDraft;
  if (!draft || kakaRequest) return;
  const key = kakaElement('kakaKey').value.trim(), model = kakaElement('kakaModel').value.trim();
  if (!key || !model) { kakaStatus('请填写 DeepSeek 的 API Key 和模型 ID。'); return; }
  const controller = new AbortController();
  kakaRequest = controller;
  const revision = draft.revision;
  const corrected = [];
  kakaElement('kakaCorrect').disabled = true;
  try {
    const origin = 'https://api.deepseek.com';
    if (!await chrome.permissions.request({origins:[origin + '/*']})) throw Error('需要允许连接 DeepSeek 才能校正。');
    for (let offset = 0; offset < draft.rows.length; offset += 20) {
      const batch = draft.rows.slice(offset, offset + 20);
      kakaStatus('正在校正第 ' + (offset + 1) + ' 至 ' + (offset + batch.length) + ' 句…');
      const input = Object.fromEntries(batch.map((row, i) => [i, row.t]));
      const response = await fetch(origin + '/chat/completions', {
        method:'POST', credentials:'omit', redirect:'error', cache:'no-store',
        signal:AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
        headers:{'Content-Type':'application/json', Authorization:'Bearer ' + key},
        body:JSON.stringify({model, messages:[{role:'system', content:draft.prompt}, {role:'user', content:JSON.stringify(input)}], response_format:{type:'json_object'}})
      });
      if (!response.ok) throw Error('DeepSeek 返回 ' + response.status + '，请检查模型、密钥和余额。');
      const answer = (await response.json()).choices?.[0];
      if (answer?.finish_reason !== 'stop') throw Error('校正结果不完整，请重试。');
      const out = JSON.parse(answer.message.content);
      if (!out || Object.keys(out).length !== batch.length ||
          !batch.every((row, i) => typeof out[i] === 'string' && (out[i].trim() || !row.t.trim()))) throw Error('校正结果缺少字幕行，请重试。');
      corrected.push(...batch.map((row, i) => ({...row, t:out[i].trim()})));
    }
    if (kakaDraft !== draft || controller.signal.aborted) return;
    if (draft.revision !== revision) throw Error('校正期间你修改了字幕，已保留手动修改。');
    draft.rows = corrected;
    draft.revision++;
    renderKakaLines(draft);
    await saveKakaDraft(draft);
    if (draft === kakaDraft) kakaStatus('AI 校正完成，可逐句检查并复制。');
  } catch (error) {
    if (draft === kakaDraft) kakaStatus('未应用 AI 校正。' + error.message);
  } finally {
    if (kakaRequest === controller) { kakaRequest = null; kakaElement('kakaCorrect').disabled = false; }
  }
};
