// Shared by the on-demand video reader and the comparison editor. Counts retain the
// precision Douyin displayed (e.g. 1.2万); a missing value never means zero.
(() => {
 const keys=['fans','likes','comments'];
 function count(value){
  if(typeof value!=='number' && typeof value!=='string')return '';
  const s=String(value).trim();
  return /^(?:(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})*)|(?:0|[1-9]\d*)(?:\.\d+)?[万亿])\+?$/.test(s)?s:'';
 }
 function fromItem(item,id){
  if(!id||String(item?.aweme_id??item?.awemeId??'')!==id)return null;
  const a=item.author||{},s=item.statistics||{};
  return {fans:count(a.follower_count??a.followerCount),likes:count(s.digg_count??s.diggCount),comments:count(s.comment_count??s.commentCount)};
 }
 function workId(){
  const urlId=new URL(location.href).searchParams.get('modal_id')||location.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1];
  if(urlId)return urlId;
  const slides=document.querySelectorAll('[data-e2e="feed-active-video"][data-e2e-vid]');
  const id=slides.length===1?slides[0].getAttribute('data-e2e-vid'):'';
  return /^\d+$/.test(id)?id:'';
 }
 async function read(id){
  const out={fans:'',likes:'',comments:''};
  if(!id || workId()!==id)return out;
  let sec='';
  const merge=item=>{const m=fromItem(item,id);if(!m)return;
   sec ||= item.author?.sec_uid||item.author?.secUid||'';
   for(const k of keys)if(!out[k]&&!(k==='fans'&&m[k]==='0'))out[k]=m[k];
  };
  const scripts=document.querySelectorAll('script[type="application/json"],script#RENDER_DATA');
  for(const el of scripts){
   let raw=el.textContent.trim();if(raw.length>5000000||!raw.includes(id))continue;
   try{
    if(raw.startsWith('%'))raw=decodeURIComponent(raw);
    const stack=[JSON.parse(raw)];
    for(let n=0;n<24000&&stack.length;n++){
     const x=stack.pop();if(!x||typeof x!=='object')continue;
     merge(x);if(keys.every(k=>out[k]))break;
     for(const v of Object.values(x))if(v&&typeof v==='object')stack.push(v);
    }
   }catch{}
   if(keys.every(k=>out[k]))break;
  }
  if(keys.some(k=>!out[k])){
   try{
    const u=performance.getEntriesByType('resource').map(e=>new URL(e.name,location.href)).reverse().find(u=>u.origin===location.origin&&u.pathname==='/aweme/v1/web/aweme/detail/'&&u.searchParams.get('aweme_id')===id);
    if(u){const r=await fetch(u.href,{signal:AbortSignal.timeout(1800)});if(r.ok)merge((await r.json()).aweme_detail)}
   }catch{}
  }
  if(workId()!==id)throw Error('作品已切换，请重新读取。');
  const active=()=>[...document.querySelectorAll('[data-e2e="feed-active-video"][data-e2e-vid]')].find(e=>e.getAttribute('data-e2e-vid')===id);
  const detail=()=>{const all=[...document.querySelectorAll('[data-e2e="video-detail"]')].filter(e=>e.checkVisibility());return !document.querySelector('[data-e2e="feed-active-video"]')&&all.length===1&&(!all[0].dataset.e2eVid||all[0].dataset.e2eVid===id)?all[0]:null};
  const root=active()||detail();
  if(root){
   for(const [k,sel] of [['likes','[data-e2e="video-player-digg"]'],['comments','[data-e2e="feed-comment-icon"]']]){
    const els=[...root.querySelectorAll(sel)].filter(el=>el.checkVisibility());
    if(!out[k]&&els.length===1)out[k]=count(els[0].innerText);
   }
   // Author identity is the profile linked by this video's avatar; the viewer's own
   // profile, nearby slides, and suggested creators must never supply this number.
   const avatar=root.querySelector('a[data-e2e="video-avatar"][href*="/user/"],[data-e2e="user-info"] a[href*="/user/"]');
   const author=avatar&&new URL(avatar.href).pathname;
   if(author&&/^\/user\/[\w-]+$/.test(author))sec=author.slice(6);
   if(author&&/^\/user\/[\w-]+$/.test(author)&&(!out.fans||out.fans==='0')){
    if(out.fans==='0')out.fans='';
    const card=()=>{
     for(const a of root.querySelectorAll('a[href*="/user/"]')){
      if(!a.checkVisibility()||new URL(a.href).pathname!==author)continue;
      const t=a.innerText,match=t.match(/([\d.,]+[万亿]?\+?)\s*粉丝/)||t.match(/粉丝\s*([\d.,]+[万亿]?\+?)/);
      const v=count(match?.[1]);
      if(v&&(v!=='0'||/获赞/.test(t)))return v;
     }return '';
    };
    out.fans=card();const tab=root.querySelector('[role="tab"][id="semiTabauthor_card"]');
    const prior=tab?.closest('[role="tablist"]')?.querySelector('[aria-selected="true"]');
    const switched=!out.fans&&tab&&prior&&prior!==tab;
    if(switched)tab.click();
    try{
     for(let n=0;!out.fans&&tab&&n<32;n++){
      if(workId()!==id||!root.isConnected||tab.getAttribute('aria-selected')!=='true')break;
      out.fans=card();
      if(!out.fans)await new Promise(r=>setTimeout(r,250));
     }
    }finally{if(switched&&workId()===id&&prior.isConnected&&tab.getAttribute('aria-selected')==='true')prior.click()}
   }
  }
  if(!out.fans&&/^[\w-]{6,160}$/.test(sec)){
   // Use only the public profile for the author identified by the exact work.
   try{
    const u=new URL('/aweme/v1/web/user/profile/other/',location.origin);
    u.search=new URLSearchParams({aid:'6383',device_platform:'webapp',sec_user_id:sec});
    const res=await fetch(u,{signal:AbortSignal.timeout(3500)});if(res.ok){
     const {user,status_code}=await res.json();
     if(status_code===0&&user?.sec_uid===sec)out.fans=count(user.follower_count);
    }
   }catch{}
  }
  if(workId()!==id)throw Error('作品已切换，请重新读取。');
  return out;
 }
 globalThis.ShijuMetrics={keys,count,fromItem,read,workId};
})();
