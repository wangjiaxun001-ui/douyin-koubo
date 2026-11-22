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
        job.message = '正在核对画面字幕与原声… '+percent+'%';
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
