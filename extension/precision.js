// A dedicated native port owns one job and is disconnected when that job stops.
const precisionSessions = new Map();

function connectPrecision(job) {
  const port = chrome.runtime.connectNative('cn.shiju.videocaptioner');
  let pending, closed = false, timeout;
  function fail(error) {
    clearTimeout(timeout);
    if (pending) pending.reject(error);
    pending = null;
    closed = true;
  }
  function armTimeout() {
    clearTimeout(timeout);
    timeout = setTimeout(() => fail(Error('本机精校响应超时。')), 150000);
  }
  port.onDisconnect.addListener(() => fail(Error(chrome.runtime.lastError?.message || '本机精校已断开。')));
  port.onMessage.addListener(message => {
    if (!pending || closed) return;
    if (message.error) { fail(Error(message.error)); return; }
    if (message.checkingPicture) {
      if (state === job && job.phase === 'fast') {
        const percent = Math.min(99,Math.floor((message.pictureTime || 0) / job.duration * 100));
        if(job.mode==='picture')job.time=Math.min(job.duration,Math.max(0,message.pictureTime||0));
        job.message = (job.mode==='picture'?'正在逐帧读取原字幕… ':'正在核对画面字幕与原声… ')+percent+'%';
        save();
      }
      armTimeout();
      return;
    }
    if (message.rows) {
      if (state !== job || job.phase !== 'fast') return;
      const rows = message.rows.filter(r => r.t && r.e > r.s && r.s < job.duration)
        .map(r => ({s:Math.max(0,r.s), e:Math.min(job.duration,r.e), t:r.t}));
      job.rows.push(...rows);
      if (rows.length) job.time = rows.at(-1).e;
      save();
      armTimeout();
      return;
    }
    clearTimeout(timeout);
    const {resolve} = pending;
    pending = null;
    resolve(message);
  });
  const session = {
    request(message) {
      if (closed || pending) return Promise.reject(Error('本机精校未连接。'));
      return new Promise((resolve,reject) => {
        pending = {resolve,reject};
        armTimeout();
        try { port.postMessage(message); } catch(error) { fail(error); }
      });
    },
    close() {
      fail(Error('已停止'));
      port.disconnect();
      precisionSessions.delete(job.token);
    }
  };
  precisionSessions.set(job.token, session);
  return session;
}

async function extractPictureOnly(job) {
  if (!chrome.runtime.connectNative || !await chrome.permissions.contains({permissions:['nativeMessaging']})) {
    throw Error('读取画面字幕需要连接本机助手。请允许本机连接后重试；本次没有改用语音听写。');
  }
  guard(job);
  const session=connectPrecision(job);
  try {
    const ready=await session.request({op:'pictureOnly',duration:job.duration});
    if (!ready.ready || !ready.pictureOnly) throw Error('请更新本机字幕助手后重试。');
    job.source='画面字幕';
    job.message='正在读取原视频画面，随后识别中文字幕…';await save();
    const read=async()=>{
      const [reference]=await chrome.scripting.executeScript({target:{tabId:job.tab},world:'MAIN',func:playerAddresses,args:[job.workId||'',true]});
      guard(job);
      return page(job,'videoBytes',reference?.result||[]);
    };
    let size;
    try { size=await read(); }
    catch(error) {
      guard(job);
      if(error.code!=='NO_MEDIA_URL'||!await openIndependentWork(job))throw error;
      size=await read();
    }
    guard(job);
    if(!size)throw Error('未取得完整视频画面。本次没有改用语音听写，请打开作品独立页后重试。');
    for(let offset=0;offset<size;) {
      const part=await page(job,'videoChunk',offset);guard(job);
      if(!(part.size>0&&part.size<=size-offset))throw Error('视频画面传输中断，请重新提取。');
      await session.request({op:'picture',data:part.data});guard(job);offset+=part.size;
    }
    job.phase='fast';job.message='正在逐帧读取原字幕，完成后一次显示。';await save();
    const result=await session.request({op:'finish'});guard(job);
    if(!result.done||!result.captions?.length)throw Error('没有读到原字幕，本次没有改用语音听写。');
    await page(job,'validate');guard(job);
    job.rows=result.captions;
    job.review={uncertain:result.uncertain||[],gaps:result.gaps||[]};
    job.captionNote='文字直接来自画面中的中文字幕，未使用语音听写或 AI 改写。';
    const points=job.review.uncertain.map(i=>job.rows[i]?.s).filter(Number.isFinite);
    if(points.length)job.captionNote+=' '+points.length+' 处画面识别不稳定，需核对：'+points.slice(0,12).map(t=>Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0')).join('、')+'。';
    if(job.review.gaps.length)job.captionNote+=' 有 '+job.review.gaps.length+' 段超过 2 秒未读到字幕，请回看是否漏字。';
    job.time=job.duration;
    await end(job,'done','已按画面字幕提取 '+job.rows.length+' 行。');
  } finally { session.close(); }
}

async function tryPrecision(job) {
  if (job.mode !== 'precise' || !chrome.runtime.connectNative ||
      !await chrome.permissions.contains({permissions:['nativeMessaging']})) return false;
  guard(job);
  let session;
  try {
    session = connectPrecision(job);
    const reply = await session.request({op:'transcribe', terms:job.terms});
    if (!reply.ready) throw Error('本机精校未就绪。');
  } catch {
    session?.close();
    guard(job);
    return false;
  }
  try {
    guard(job);
    job.source = '原声精校';
    job.message = '正在读取完整音轨…';
    await save();
    const length = await readAudio(job);
    guard(job);
    job.message = '音轨已读取，正在送入本机识别…';await save();
    for (let offset = 0; offset < length;) {
      const part = await page(job,'samples',offset);
      guard(job);
      if (!(part.count > 0 && offset + part.count <= length)) throw Error('音轨已中断。');
      await session.request({op:'audio', pcm:part.pcm});
      guard(job);
      offset += part.count;
    }
    if (!job.forceVoice) {
      job.message='音轨已就绪，正在读取画面字幕参考…';await save();
      const [reference] = await chrome.scripting.executeScript({target:{tabId:job.tab}, world:'MAIN',
        func:playerAddresses, args:[job.workId || '',true]}).catch(()=>[]);
      const size = await page(job,'videoBytes',reference?.result || []).catch(()=>0);
      guard(job);
      for (let offset=0; offset<size;) {
        const part = await page(job,'videoChunk',offset);
        guard(job);
        if (!(part.size>0 && part.size<=size-offset)) throw Error('画面读取中断。');
        await session.request({op:'picture',data:part.data});
        offset+=part.size;
      }
    }
    job.phase = 'fast';
    job.message = '正在本机核对原声和句间停顿，完成后显示全文。';
    await save();
    const reply = await session.request({op:'finish'});
    if (!reply.done) throw Error('原声精校未完成。');
    guard(job);
    await page(job,'validate');
    guard(job);
    if (reply.captions?.length) {
      job.rows = reply.captions;
      job.source = '画面字幕';
    }
    job.captionNote = reply.captions?.length
      ? '已读取视频画面中的字幕。人名、品牌名仍建议对照原片核对。'
      : job.forceVoice
        ? '你选择了按原声听写，本次未读取网页和画面字幕。听写文字可能与原字幕不同。'
        : reply.pictureStatus === 'incomplete'
          ? '画面字幕未能完整读出，本次保留原声听写结果。人名、品牌名可能听错。'
          : reply.pictureStatus === 'error'
            ? '画面字幕核对失败，本次保留原声听写结果。文字尚未与原字幕核实。'
            : '本次未取得可核对的画面字幕，结果来自原声听写，可能与视频字幕不同。';
    job.time = job.duration;
    await end(job,job.rows.length?'done':'empty',job.rows.length?(reply.captions?.length?'已按画面字幕的换行与出现时间提取。':'已按原声精校并断句。'):'整条音轨未识别到清晰人声。');
    return true;
  } finally { session.close(); }
}
