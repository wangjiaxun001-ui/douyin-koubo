// Runs in the isolated world of the selected video tab, with the page's ordinary read access.
globalThis.__shijuReadTrack = async function (video, workId, signal) {
  const limit = 48 * 1024 * 1024;
  if (video.duration > 20 * 60) throw Error('这条视频超过快速模式的 20 分钟上限');
  const allowed = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.origin === location.origin || /(^|\.)douyinvod\.com$/.test(u.hostname));
    } catch { return false; }
  };
  const candidates = [];
  if (workId) {
    const detail = performance.getEntriesByType('resource').map(e => new URL(e.name, location.href)).reverse()
      .find(u => u.origin === location.origin && u.pathname === '/aweme/v1/web/aweme/detail/' && u.searchParams.get('aweme_id') === workId);
    if (detail) {
      try {
        const r = await fetch(detail.href, {signal: AbortSignal.any([signal, AbortSignal.timeout(4000)])});
        const item = r.ok && (await r.json()).aweme_detail;
        if (String(item?.aweme_id) === workId) {
          for (const {audio_meta: audio} of item.video?.bit_rate_audio || []) {
            if (!audio || audio.size > limit) continue;
            const urls = audio.url_list || {};
            candidates.push(urls.main_url, urls.backup_url);
          }
        }
      } catch { signal.throwIfAborted(); }
    }
  }
  if (allowed(video.currentSrc)) candidates.push(video.currentSrc);
  for (const url of [...new Set(candidates.filter(allowed))].slice(0, 4)) {
    const request = new AbortController();
    try {
      const r = await fetch(url, {credentials:'omit', signal:AbortSignal.any([signal, request.signal, AbortSignal.timeout(12000)])});
      if (!r.ok || !r.body || Number(r.headers.get('content-length')) > limit) continue;
      const reader = r.body.getReader(), parts = [];
      let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw Error('音轨过大');
        parts.push(value);
      }
      const bytes = await new Blob(parts).arrayBuffer();
      const decoder = new OfflineAudioContext(1, 1, 16000);
      const buffer = await decoder.decodeAudioData(bytes);
      signal.throwIfAborted();
      if (Math.abs(buffer.duration - video.duration) <= Math.max(0.35, Math.min(1, video.duration * 0.005))) return buffer;
    } catch { signal.throwIfAborted(); }
    finally { request.abort(); }
  }
  throw Error('没有读到可用的完整音轨');
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
