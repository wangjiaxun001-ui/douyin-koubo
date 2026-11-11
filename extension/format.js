const timeTag=n=>{n=Math.max(0,Math.floor(n||0));return Math.floor(n/60).toString().padStart(2,'0')+':'+(n%60).toString().padStart(2,'0')};
const warning=j=>j.phase==='done'?'':j.phase==='listening'||j.phase==='finishing'?'〔转写中 · 非完整稿〕\n':'〔未完成 · 仅含已提取部分〕\n';
const transcript=j=>warning(j)+j.rows.map(r=>timeTag(r.s)+'  '+r.t).join('\n');
function scriptText(j){
 // A continuous breath may contain several rhetorical moves, even when ASR emits no punctuation.
 // Subclauses share their source segment's time range; never invent word timings.
 const rs=j.rows.flatMap(r=>{
   const parts=r.t.split(/(?<=[。！？!?；])|(?=首先|第一步|第二步|第三步|然后|接下来|举个例子|比如说|最后|总之)/u).map(t=>t.trim()).filter(Boolean);
   return parts.map(t=>({...r,t}));
 }),lines=[];
 for(let i=0;i<rs.length;i++){
  const r=rs[i];let label;
  if(rs.length===1)label='口播';
  else if(i===0)label=/[?？]|为什么|怎么|有没有/.test(r.t)?'开场提问':'开场';
  else if(i===rs.length-1)label=j.phase==='done'?(/关注|点赞|收藏|评论|试试/.test(r.t)?'结尾引导':'收尾'):'当前末段';
  else label=/例如|比如|举个例子/.test(r.t)?'举例':/首先|接着|然后|第一|第二|步骤/.test(r.t)?'步骤':/因为|原因|所以/.test(r.t)?'解释':'展开';
  const last=lines.at(-1);if(last&&last.label===label){last.e=r.e;last.ts.push(r.t)}else lines.push({label,s:r.s,e:r.e,ts:[r.t]})
 }
 return warning(j)+lines.map(x=>'【'+x.label+'】 '+timeTag(x.s)+'–'+timeTag(x.e)+'\n'+x.ts.join('\n')).join('\n\n')
}
