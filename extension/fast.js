// Runs in the isolated world of the selected video tab, with the page's ordinary read access.
globalThis.__shijuReadTrack = async function (video, items, signal, playerUrls, progress = () => {}) {
  const limitMiB = 512;
  const limit = limitMiB * 1024 * 1024;
  if (video.duration > 45 * 60) throw Error('这条视频超过原声转写的 45 分钟上限');
  const allowed = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.origin === location.origin || /(^|\.)douyinvod\.com$/.test(u.hostname));
    } catch { return false; }
  };
  const candidates = Array.isArray(playerUrls) ? playerUrls.filter(allowed) : [];
  for (const item of items) {
    const media = item.video || {};
    for (const track of media.bit_rate_audio || media.bitRateAudio || []) {
      const audio = track.audio_meta || track.audioMeta;
      if (!audio) continue;
      const urls = audio.url_list || audio.urlList || {};
      candidates.push(...(Array.isArray(urls) ? urls : [urls.main_url, urls.backup_url]));
    }
    const address = media.play_addr || media.playAddr;
    if (address) candidates.push(...(address.url_list || address.urlList || []));
  }
  const direct = allowed(video.currentSrc) ? video.currentSrc : null;
  const deadline = AbortSignal.timeout(8 * 60 * 1000);
  const failures = new Set();
  const urls = [...new Set(candidates.filter(url => allowed(url) && url !== direct))].slice(0, direct ? 3 : 4);
  if (direct) urls.push(direct);
  if (!urls.length) throw Object.assign(Error('没有找到这条作品的完整音轨地址。请打开下方的独立作品页，再从工具栏点拾句。'), {code:'NO_MEDIA_URL'});
  for (const url of urls) {
    if (deadline.aborted) break;
    const request = new AbortController();
    try {
      progress({stage:'download', bytes:0});
      const r = await fetch(url, {credentials:'omit', signal:AbortSignal.any([signal, deadline, request.signal, AbortSignal.timeout(5 * 60 * 1000)])});
      if (!r.ok || !r.body) {
        failures.add('下载失败'+(r.status ? '（HTTP '+r.status+'）' : ''));
        await r.body?.cancel();
        continue;
      }
      if (Number(r.headers.get('content-length')) > limit) {
        failures.add(`媒体文件超过 ${limitMiB} MiB`);
        await r.body.cancel();
        continue;
      }
      const reader = r.body.getReader(), parts = [];
      let size = 0, reportedAt = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          failures.add(`媒体文件超过 ${limitMiB} MiB`);
          await reader.cancel();
          break;
        }
        if (Date.now() - reportedAt >= 500) {
          progress({stage:'download', bytes:size});
          reportedAt = Date.now();
        }
        parts.push(value);
      }
      if (size > limit) continue;
      progress({stage:'decode', bytes:size});
      const media = new Blob(parts);
      parts.length = 0;
      const bytes = await media.arrayBuffer();
      const decoder = new OfflineAudioContext(1, 1, 16000);
      const decodeSignal = AbortSignal.any([signal, deadline, AbortSignal.timeout(60000)]);
      const buffer = await new Promise((resolve,reject) => {
        const abort = () => reject(decodeSignal.reason);
        decodeSignal.addEventListener('abort',abort,{once:true});
        if (decodeSignal.aborted) abort();
        decoder.decodeAudioData(bytes).then(resolve,reject).finally(() => decodeSignal.removeEventListener('abort',abort));
      });
      signal.throwIfAborted();
      if (Math.abs(buffer.duration - video.duration) <= Math.max(0.35, Math.min(1, video.duration * 0.005))) return buffer;
      failures.add('音轨时长与当前视频不一致');
    } catch (error) {
      signal.throwIfAborted();
      failures.add(error.name === 'TimeoutError' ? '下载或解码超时' :
        error.name === 'EncodingError' ? '浏览器无法解码这条音轨' : '媒体地址无法读取');
    }
    finally { request.abort(); }
  }
  if (deadline.aborted) failures.add('读取完整音轨超时');
  throw Error('未能读取完整音轨：'+[...failures].join('；')+'。可以打开下方的独立作品页后重试。');
};

globalThis.__shijuVideoBytes = async function(video, items, urls, signal, progress=()=>{}) {
  const limit = 512 * 1024 * 1024;
  if(video.duration>45*60)throw Error('画面字幕支持 45 分钟以内的视频。');
  const allowed=value=>{try{const u=new URL(value);return u.protocol==='https:'&&(u.origin===location.origin||/(^|\.)douyinvod\.com$/.test(u.hostname)||/^v\d+(?:-[a-z0-9]+)*\.ixigua\.com$/.test(u.hostname))}catch{return false}};
  const candidates = [...new Set([...urls, ...items.flatMap(item => item.video?.play_addr?.url_list || []), video.currentSrc].filter(allowed))].slice(0,6);
  if(!candidates.length)throw Object.assign(Error('没有找到完整视频画面地址，未改用语音听写。'),{code:'NO_MEDIA_URL'});
  const deadline = AbortSignal.timeout(8*60*1000),failures=new Set();
  for (const value of candidates) {
    if(deadline.aborted)break;
    const request=new AbortController();
    try {
      progress({stage:'picture',bytes:0});
      const r = await fetch(value,{signal:AbortSignal.any([signal,deadline,request.signal,AbortSignal.timeout(5*60*1000)]),credentials:'omit'});
      if (!r.ok || !r.body) {failures.add('视频地址读取失败');await r.body?.cancel();continue;}
      if(Number(r.headers.get('content-length'))>limit){failures.add('视频超过 512 MiB');await r.body.cancel();continue;}
      const reader = r.body.getReader(), chunks = [];
      let size = 0,reportedAt=0;
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {failures.add('视频超过 512 MiB');await reader.cancel();break;}
        chunks.push(value);
        if(Date.now()-reportedAt>=500){progress({stage:'picture',bytes:size});reportedAt=Date.now();}
      }
      if (size && size <= limit) return new Blob(chunks);
    } catch(error) {
      signal.throwIfAborted();failures.add(error.name==='TimeoutError'?'视频读取超时':'视频下载中断');
    } finally {request.abort();}
  }
  throw Error('未能读取完整视频画面：'+[...failures].join('；')+'。本次没有改用语音听写。');
};

globalThis.__shijuSamples = function (buffer, offset) {
  const count = Math.min(64000, buffer.length - offset);
  const pcm = new Int16Array(count);
  const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[offset + i];
    pcm[i] = Math.round(Math.max(-1, Math.min(1, sum / channels.length)) * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  if (bytes.toBase64) return {pcm:bytes.toBase64(), count};
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return {pcm:btoa(binary), count};
};
