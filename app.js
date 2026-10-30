(() => {
  const app=document.getElementById('app');let view='home',playerTab='overview',transitionBusy=false,advanceBusy=false;
// 渲染兜底：任何异常都给出可恢复界面，不白屏
let __renderFailing=false;
function __safeShell(build){
  try{
    shell(build());
    __renderFailing=false;
  }catch(err){
    console.error('render error',err);
    if(__renderFailing)return;
    __renderFailing=true;
    try{
      app.innerHTML='<div class="fw-page"><div class="shell"><section class="card" style="margin-top:40px"><div class="eyebrow">RECOVER</div><h2 style="margin:6px 0">页面加载出了点问题</h2><p class="muted">存档没有丢失。可以返回上一页，或回到首页继续。</p><div class="actions" style="margin-top:14px"><button class="btn primary" id="rec-home">回首页</button><button class="btn" id="rec-reload">重新载入</button></div></section></div></div>';
      const b1=document.getElementById('rec-home');if(b1)b1.onclick=()=>{view='home';playerTab='overview';renderImmediate()};
      const b2=document.getElementById('rec-reload');if(b2)b2.onclick=()=>location.reload();
    }catch(e){}
  }
}
function renderImmediate(){try{applyClubTheme(FW.state.player&&FW.state.player.clubId)}catch(e){}try{maybeShowBriefing()}catch(e){}try{maybeShowCallup()}catch(e){}__safeShell(function(){return view==='home'?home():view==='player'?player():view==='matches'?matches():view==='market'?market():view==='playerDetail'?playerDetail():view==='clubDetail'?clubDetail():view==='national'?national():view==='nationalDetail'?nationalDetail():view==='cupDetail'?cupDetail():view==='ntDetail'?ntDetail():view==='competitionDetail'?competitionDetail():view==='appearance'?appearanceEditor():view==='matchday'?matchday():view==='agent'?agent():world()})}
  function renderAnimated(){transitionBusy=true; try{const old=app.firstElementChild; if(old) old.classList.add('fw-page-out'); renderImmediate(); const next=app.firstElementChild; if(next){next.classList.remove('fw-page'); next.classList.add('fw-page-in'); requestAnimationFrame(()=>requestAnimationFrame(()=>next.classList.add('fw-page-in-active')))}}catch(e){console.error(e); try{renderImmediate()}catch(e2){console.error(e2)}} finally{window.setTimeout(()=>{transitionBusy=false},120)}}
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));  const playerNameHTML=p=>{const zh=p?.nameZh||p?.name||'球员',en=p?.nameEn&&p.nameEn!==zh?p.nameEn:'';return `<span class="player-name-stack"><span class="player-name-zh">${esc(zh)}</span>${en?`<span class="player-name-en">${esc(en)}</span>`:''}</span>`};  function closeFocusLayer(){document.querySelectorAll('.focus-layer').forEach(x=>x.remove());}
  function showFocusPrompt(items,days){
    closeFocusLayer();
    const primary=items[0];
    const layer=document.createElement('div');layer.className='focus-layer';
    layer.innerHTML=`<div class="focus-backdrop"></div><div class="focus-dialog" role="dialog" aria-modal="true"><div class="focus-kicker">FOCUS MATCH</div><div class="focus-icon">✦</div><h2>焦点战即将到来</h2><p class="focus-lead">你这次推进 ${days} 天，会跳过一场值得关注的比赛。</p><div class="focus-match"><div><span>${esc(primary.kind)}</span>${primary.promotionLabel?`<em class="focus-promotion">${esc(primary.promotionLabel)}</em>`:''}<b>${esc(primary.homeName)}</b><small>vs</small><b>${esc(primary.awayName)}</b></div><time>${esc(primary.date)}</time></div>${items.length>1?`<div class="focus-more">另外还有 ${items.length-1} 场焦点战会在本次推进中被自动模拟。</div>`:''}<div class="focus-actions"><button class="btn primary" data-focus-continue="1">继续跳过</button><button class="btn" data-focus-enter="1">进入比赛日</button></div><div class="focus-note">继续跳过后，比赛会自动进行；你不会看到这场比赛的赛前决策过程。</div></div>`;
    document.body.appendChild(layer);
    layer.querySelector('[data-focus-continue]').onclick=()=>{closeFocusLayer();performAdvanceWithFocus(days,items)};
    layer.querySelector('[data-focus-enter]').onclick=()=>{closeFocusLayer();navTo('matches')};
    requestAnimationFrame(()=>layer.classList.add('focus-layer-show'));
  }
  function showFocusResult(result){
    closeFocusLayer();
    const layer=document.createElement('div');layer.className='focus-layer focus-result-layer';
    const success=result.success;
    const title=success?(result.kind==='冠军争夺战'?'CHAMPIONSHIP MOMENT':result.kind==='升级关键战'?'PROMOTION PUSH':result.kind==='保级关键战'?'SAFE':'BIG RESULT'):'FOCUS MATCH RESULT';
    layer.innerHTML=`<div class="focus-backdrop"></div><div class="focus-result"><div class="focus-kicker">${title}</div><div class="focus-result-mark">${success?'✦':'—'}</div><div class="focus-result-kind">${esc(result.kind)}</div><h2>${success?esc(result.headline):esc(result.headline)}</h2><div class="focus-score"><span>${esc(result.homeName)}</span><b>${result.score.home} <i>—</i> ${result.score.away}</b><span>${esc(result.awayName)}</span></div><div class="focus-date">${esc(result.date)}</div><button class="btn primary" data-focus-close="1">继续</button></div>`;
    document.body.appendChild(layer);requestAnimationFrame(()=>layer.classList.add('focus-layer-show'));
    layer.querySelector('[data-focus-close]').onclick=closeFocusLayer;
    window.setTimeout(()=>{if(document.body.contains(layer))closeFocusLayer()},6500);
  }
  function showCareerOutcome(outcome){
    if(!outcome)return false;
    closeFocusLayer();
    const promoted=outcome.type==='promotion';
    const title=promoted?'PROMOTION SECURED':'SEASON TURN';
    const main=promoted?`升级成功 · 第${outcome.toTier}级联赛`:`未能晋级 / 遭遇降级`;
    const detail=promoted?`从第${outcome.fromTier}级 · ${esc(outcome.fromLeague)}，升入第${outcome.toTier}级 · ${esc(outcome.toLeague)}`:`本赛季结束后，球队未能完成升级目标，或从第${outcome.fromTier}级降至第${outcome.toTier}级。`;
    const advice=promoted?'这一刻属于整个球队。新的联赛，新的舞台。':'球员能力值越高越容易赢下比赛，快去训练吧';
    const layer=document.createElement('div');layer.className='focus-layer focus-result-layer';
    layer.innerHTML=`<div class=\"focus-backdrop\"></div><div class=\"focus-result career-outcome ${promoted?'is-promotion':'is-relegation'}\"><div class=\"focus-kicker\">${title}</div><div class=\"focus-result-mark\">${promoted?'↑':'—'}</div><div class=\"focus-result-kind\">赛季结算 · ${esc(outcome.date)}</div><h2>${main}</h2><p class=\"career-outcome-detail\">${detail}</p><div class=\"career-outcome-advice\">${advice}</div><button class=\"btn primary\" data-career-outcome-close=\"1\">继续我的生涯</button></div>`;
    document.body.appendChild(layer);requestAnimationFrame(()=>layer.classList.add('focus-layer-show'));
    layer.querySelector('[data-career-outcome-close]').onclick=closeFocusLayer;
    window.setTimeout(()=>{if(document.body.contains(layer))closeFocusLayer()},7000);
    return true;
  }

  function performAdvanceWithFocus(days,items){
    if(advanceBusy)return;
    advanceBusy=true;
    const focusIds=new Set(items.map(x=>x.fixtureId));
    try{FW.advance(days);if(window.autoSave)autoSave();const results=[];for(const id of focusIds){const m=FW.state.matches.find(x=>x.fixtureId===id);if(m){const it=items.find(x=>x.fixtureId===id);results.push({success:(FW.state.player?.clubId===m.homeClubId?m.score.home>m.score.away:m.score.away>m.score.home),draw:m.score.home===m.score.away,kind:it?.kind||'焦点战',headline:(FW.state.player?.clubId===m.homeClubId?m.score.home>m.score.away:m.score.away>m.score.home)?(it?.kind==='冠军争夺战'?'继续向冠军发起冲击':it?.kind==='升级关键战'?'升级希望大幅提升':it?.kind==='保级关键战'?'成功守住保级主动权':'关键战拿下三分'):m.score.home===m.score.away?'关键战战平，悬念仍在':'关键战失利，形势变得更加紧张',homeName:FW.clubName(m.homeClubId),awayName:FW.clubName(m.awayClubId),score:m.score,date:m.date});}}
      const best=results.sort((a,b)=>(b.success?2:b.draw?1:0)-(a.success?2:a.draw?1:0))[0];
      renderImmediate();
      if(FW.state.lastCareerOutcome){const outcome=FW.state.lastCareerOutcome;FW.state.lastCareerOutcome=null;showCareerOutcome(outcome);}
      else if(best)showFocusResult(best);
    }catch(e){console.error(e);renderImmediate();alert('时间推进出现异常，请继续尝试。')}finally{advanceBusy=false}
  }

  // 六维能力雷达（SVG）
  function radarSVG(stats, size) {
    const keys = ['speed', 'shooting', 'passing', 'control', 'defense', 'stamina'];
    const labels = { speed: '速度', shooting: '射门', passing: '传球', control: '控球', defense: '防守', stamina: '体能' };
    const S = size || 170;
    const cx = S / 2, cy = S / 2, R = S * 0.36;
    const pt = (i, r) => {
      const a = (Math.PI * 2 * i) / keys.length - Math.PI / 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    let grid = '';
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const pts = keys.map((k, i) => pt(i, R * f).join(',')).join(' ');
      grid += `<polygon points="${pts}" fill="none" stroke="rgba(20,24,32,.07)" stroke-width="1"/>`;
    }
    const spokes = keys.map((k, i) => {
      const [x, y] = pt(i, R);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(20,24,32,.07)" stroke-width="1"/>`;
    }).join('');
    const pts = keys.map((k, i) => {
      const v = Math.max(6, Math.min(100, Number(stats[k]) || 0));
      return pt(i, (R * v) / 100).join(',');
    }).join(' ');
    const dots = keys.map((k, i) => {
      const v = Math.max(6, Math.min(100, Number(stats[k]) || 0));
      const [x, y] = pt(i, (R * v) / 100);
      return `<circle cx="${x}" cy="${y}" r="2.6" fill="var(--c1,#2F4858)"/>`;
    }).join('');
    const texts = keys.map((k, i) => {
      const [x, y] = pt(i, R + 15);
      return `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="10" fill="rgba(35,40,50,.55)">${labels[k]}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="能力雷达图">
      ${grid}${spokes}
      <polygon points="${pts}" fill="color-mix(in srgb, var(--c1,#2F4858) 16%, transparent)" stroke="var(--c1,#2F4858)" stroke-width="1.4" stroke-linejoin="round"/>
      ${dots}${texts}
    </svg>`;
  }

  // 评分走势折线
  function sparkline(values, opts) {
    const o = opts || {};
    const w = o.width || 240, h = o.height || 46, pad = 4;
    const vals = (values || []).filter((v) => typeof v === 'number');
    if (vals.length < 2) return '<div class="subtle" style="font-size:12px">数据不足，多踢几场就能看到走势</div>';
    const min = Math.min.apply(null, vals) - 0.2, max = Math.max.apply(null, vals) + 0.2;
    const span = Math.max(0.4, max - min);
    const step = (w - pad * 2) / (vals.length - 1);
    const pts = vals.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L ${pts[0][0].toFixed(1)} ${h - pad} Z`;
    const dots = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.8" fill="var(--c1,#2F4858)" opacity=".85"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="评分走势">
      <path d="${area}" fill="color-mix(in srgb, var(--c1,#2F4858) 10%, transparent)"/>
      <path d="${line}" fill="none" stroke="var(--c1,#2F4858)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>`;
  }
  const statLabels={speed:'速度',shooting:'射门',passing:'传球',control:'控球',defense:'防守',stamina:'体能'};
  const positionLabels={GK:'门将',CB:'中后卫',LB:'左后卫',RB:'右后卫',CM:'中场',AM:'前腰',LW:'左边锋',RW:'右边锋',ST:'前锋'};
  const posLabel=p=>positionLabels[p]||p||'—';
  const roleLabels={'key player':'核心球员',regular:'常规主力',rotation:'轮换球员',fringe:'边缘球员'};
  const roleLabel=r=>roleLabels[r]||'边缘球员';
  // ── 赛事详情页 ──────────────────────────────────────────────────────
  // 国内杯赛详情
  function cupDetail(){
    const id=window.__selectedCupId;
    const d=FW.cupDetail?FW.cupDetail(id):null;
    if(!d)return '<div class="grid"><section class="card"><div class="empty">杯赛不存在。</div><div class="actions" style="margin-top:12px"><button class="btn" data-back="1">← 返回</button></div></section></div>';
    const slotName={UEL:'欧洲联赛',UECL:'欧洲协会联赛',ACLE:'亚足联冠军联赛精英赛',ACL2:'亚足联冠军联赛二级',LIB:'南美解放者杯'}[d.slotTo]||'';
    const rounds=(d.rounds||[]).map(r=>'<div class="bracket-round"><div class="br-title">'+esc(r.name)+(r.date?' · '+esc(r.date):'')+'</div>'
      +(r.ties||[]).map(t=>'<div class="tie-row"><span class="tie-team'+(t.winner===t.home?' win':'')+'">'+esc(FW.clubName(t.home))+'</span><span class="tie-score">'+(t.score?(t.score.home+'-'+t.score.away):'待赛')+'</span><span class="tie-team'+(t.winner===t.away?' win':'')+'">'+esc(FW.clubName(t.away))+'</span><span class="tie-win">'+(t.winner?esc(FW.clubName(t.winner)):'')+'</span></div>').join('')
      +'</div>').join('');
    const parts=(d.participants||[]).map(x=>'<div class="entry-row"><span class="entry-club">'+clubDot(x.id)+esc(x.name)+'</span><span class="entry-via">'+esc(FW.leagueName(x.leagueId)||'')+'</span></div>').join('');
    return '<div class="grid"><section class="card cup-detail" style="'+clubVars(FW.state.player?FW.state.player.clubId:null)+'">'
      +'<div class="section-head"><div><div class="eyebrow">DOMESTIC CUP</div><h2 style="margin:6px 0">'+esc(d.name)+'</h2><div class="muted">'+esc(d.format||'')+' · '+(d.participants||[]).length+' 队</div></div><span class="badge">'+(d.champion?'冠军 '+esc(FW.clubName(d.champion)):'进行中')+'</span></div>'
      +(slotName?'<div class="notice">冠军将获得 <b>'+esc(slotName)+'</b> 参赛名额</div>':'')
      +'<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">BRACKET</div><h3>淘汰赛进程</h3></div></div>'
      +rounds
      +'<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">ENTRIES</div><h3>参赛球队</h3></div></div><div class="intl-entries">'+parts+'</div>'
      +'</section></div>';
  }

  // 国家队赛事详情
  function ntDetail(){
    const d=FW.nationalTournamentDetail?FW.nationalTournamentDetail(window.__selectedNtId):null;
    if(!d)return '<div class="grid"><section class="card"><div class="empty">赛事不存在。</div><div class="actions" style="margin-top:12px"><button class="btn" data-back="1">← 返回</button></div></section></div>';
    const groups=(d.groups||[]).map(g=>'<div class="ntg-box"><div class="ntg-title">'+esc(g.name)+'</div>'
      +(g.table||[]).map((r,i)=>'<div class="ntg-row'+(i<2?' adv':'')+'"><span>'+(i+1)+'</span><span>'+esc(r.country)+'</span><span>'+r.p+'</span><b>'+r.pts+'</b></div>').join('')+'</div>').join('');
    const ko=(d.knockout||[]).map(r=>'<div class="ntk-row"><span class="ntk-stage">'+esc(r.stage)+'</span><span>'+esc(r.home)+' '+r.score.home+'-'+r.score.away+' '+esc(r.away)+'</span><b>'+esc(r.winner)+'</b></div>').join('');
    return '<div class="grid"><section class="card nt-hero" style="'+flagVars((FW.state.player&&FW.state.player.nationality)||'中国')+'">'
      +'<div class="section-head"><div><div class="eyebrow">NATIONAL COMPETITION</div><h2 style="margin:6px 0">'+esc(d.name)+'</h2><div class="muted">'+esc(d.season)+' · '+d.teams+' 队 · 冠军 '+(d.champion?esc(d.champion):'未产生')+'</div></div></div>'
      +(groups?'<div class="section-head" style="margin-top:16px"><div><div class="eyebrow">GROUPS</div><h3>小组积分</h3></div></div><div class="ntg-grid">'+groups+'</div>':'')
      +(ko?'<div class="section-head" style="margin-top:16px"><div><div class="eyebrow">KNOCKOUT</div><h3>淘汰赛</h3></div></div><div class="ntk-list">'+ko+'</div>':'')
      +'</section></div>';
  }

  function competitionDetail(){
    const id=window.__selectedCompId;
    const d=FW.competitionDetail?FW.competitionDetail(id):null;
    if(!d)return `<div class="grid"><section class="card"><div class="empty">赛事不存在或尚未开始。</div><div class="actions" style="margin-top:12px"><button class="btn" data-back="1">← 返回</button></div></section></div>`;
    const roundIdx=window.__compRound||0;
    const rounds=d.rounds||[];
    const cur=rounds[Math.min(roundIdx,Math.max(0,rounds.length-1))];
    const tableRows=d.table.map((r,i)=>`<tr class="league-row${i<8?' ucl':''}" style="${clubVars(r.clubId)}"><td class="rank">${i+1}</td><td class="club-name"><button class="table-club-link" data-world-club-id="${r.clubId}">${clubDot(r.clubId)}${esc(FW.clubName(r.clubId))}</button></td><td>${r.p}</td><td>${r.w}-${r.d}-${r.l}</td><td>${r.gf}:${r.ga}</td><td><b>${r.pts}</b></td></tr>`).join('');
    const roundTabs=rounds.map((r,i)=>`<button class="chip-btn${i===roundIdx?' on':''}" data-comp-round="${i}">第 ${r.index} 轮<small>${esc(r.date.slice(5))}</small></button>`).join('');
    const ties=(cur?cur.ties:[]).map(t=>`<div class="cd-tie"><span class="cd-home">${esc(FW.clubName(t.home))}</span><span class="cd-score">${t.score.home} - ${t.score.away}</span><span class="cd-away">${esc(FW.clubName(t.away))}</span></div>`).join('');
    const bracket=(d.bracket||[]).map(r=>`<div class="bracket-round"><div class="br-title">${esc(r.name)}</div>${r.ties.map(x=>`<div class="tie-row"><span class="tie-team${x.winner===x.a?' win':''}">${esc(FW.clubName(x.a))}</span><span class="tie-score">${x.agg.a} - ${x.agg.b}</span><span class="tie-team${x.winner===x.b?' win':''}">${esc(FW.clubName(x.b))}</span><span class="tie-win">${esc(FW.clubName(x.winner))}</span></div>`).join('')}</div>`).join('');
    const list=(arr)=>arr.length?arr.map((x,i)=>`<div class="lead-row"><span class="lead-rank">${i+1}</span><span class="lead-name">${esc(x.name)}</span><span class="lead-club">${esc(FW.clubName(x.clubId))}</span><b>${x.value}</b></div>`).join(''):'<div class="subtle" style="padding:8px 0">暂无数据</div>';
    return `<div class="grid"><section class="card cd-card" style="${compVars(d.id)}">
      <div class="section-head"><div><div class="eyebrow">${esc(d.short||'赛事')}</div><h2 style="margin:6px 0">${esc(d.name)}</h2><div class="muted">${d.teams} 队 · 每队 ${d.matchesPerTeam} 场 · ${d.status==='completed'?'已结束':'进行中'}${d.champion?' · 冠军 '+esc(FW.clubName(d.champion)):''}</div></div><span class="badge">${d.teams} 队</span></div>
      <div class="section-head" style="margin-top:18px"><div><div class="eyebrow">STANDINGS</div><h3>完整积分榜</h3></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>俱乐部</th><th>场</th><th>胜平负</th><th>进/失</th><th>积分</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      ${rounds.length?`<div class="section-head" style="margin-top:20px"><div><div class="eyebrow">ROUNDS</div><h3>轮次与比分</h3></div></div><div class="cd-rounds">${roundTabs}</div><div class="cd-ties">${ties}</div>`:''}
      ${bracket?`<div class="section-head" style="margin-top:20px"><div><div class="eyebrow">KNOCKOUT</div><h3>淘汰赛</h3></div></div>${bracket}`:''}
      <div class="lead-grid" style="margin-top:20px"><div class="lead-box"><div class="lead-title">射手榜</div>${list(d.scorers)}</div><div class="lead-box"><div class="lead-title">助攻榜</div>${list(d.assists)}</div></div>
    </section></div>`;
  }

  // ── 国家队详情页 ────────────────────────────────────────────────────
  function nationalDetail(){
    const country=window.__selectedNation;
    const d=FW.nationalDetail?FW.nationalDetail(country):null;
    if(!d)return `<div class="grid"><section class="card"><div class="empty">没有这支国家队的数据。</div><div class="actions" style="margin-top:12px"><button class="btn" data-back="1">← 返回</button></div></section></div>`;
    const rows=d.squad.map(p=>`<div class="squad-row"><span class="squad-name"><button class="link-btn" data-player-detail="${esc(p.id)}">${esc(p.name)}</button></span><span class="squad-club">${esc(FW.clubName(p.clubId))}</span><span class="squad-ca">${p.ca}</span></div>`).join('');
    const fixtures=d.fixtures.map(f=>{
      const home=f.homeCountry===country;
      return `<div class="caps-row"><span class="caps-date">${esc(f.date)}</span><span class="caps-opp">${home?'vs ':'@ '}${esc(home?f.opponent:f.opponent)}</span><span class="caps-tag">${f.score.home}-${f.score.away}</span><span class="caps-g"></span></div>`;
    }).join('');
    const tours=d.tournaments.map(t=>`<div class="row"><span>${esc(t.season)} ${esc(t.name)}</span><b>${t.champion?'冠军':(t.stage||'参赛')} · ${t.wins}/${t.played}</b></div>`).join('');
    return `<div class="grid"><section class="card nt-hero" style="${flagVars(country)}">
      <div class="section-head"><div><div class="eyebrow">NATIONAL TEAM</div><h2 style="margin:6px 0">${esc(d.name)}</h2><div class="muted">${d.coach?esc(d.coach.name)+' · '+esc(d.coach.style):''}</div></div><span class="badge">世界排名 ${d.rank||'—'}</span></div>
      <div class="kpi" style="margin-top:12px"><div class="k"><b>${d.wins}-${d.draws}-${d.losses}</b><span>战绩</span></div><div class="k"><b>${d.goalsFor}</b><span>进球</span></div><div class="k"><b>${d.goalsAgainst}</b><span>失球</span></div></div>
      <div class="section-head" style="margin-top:18px"><div><div class="eyebrow">SQUAD</div><h3>本期名单</h3></div><span class="badge">${d.squad.length} 人</span></div>
      ${rows||'<div class="empty">暂无名单</div>'}
      ${fixtures?`<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">RESULTS</div><h3>近期比赛</h3></div></div>${fixtures}`:''}
      ${tours?`<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">TOURNAMENTS</div><h3>大赛战绩</h3></div></div>${tours}`:''}
    </section></div>`;
  }

  function nav(){return `<div class="nav">${[['home','首页'],['player','我的球员'],['matches','比赛'],['world','世界'],['national','国家队'],['market','球员市场'],['agent','经纪人']].map(([k,t])=>`<button class="${view===k?'active':''}" data-v="${k}"><span class="mobile-label">${t}</span><span class="desktop-time" aria-hidden="true">${t}</span></button>`).join('')}<div class="time-controls"><button class="help-toggle" data-help="1" title="快捷键（?）" aria-label="快捷键">?</button><button class="sound-toggle" data-sound="1" title="开关音效" aria-label="开关音效"><span class="sound-icon">🔊</span></button><button data-save="1" title="把当前进度保存到浏览器本地">存档</button><button data-load="1" title="读取上次的存档">读档</button><button data-adv="1">+1</button><button data-adv="7">+7</button><button data-adv="30">+30</button><button data-adv="90">+90</button></div></div>`}
  // 俱乐部配色：统一以 CSS 变量注入，界面只用细线/圆点/低透明度渐变
  // ── 俱乐部主题：跟随球员所在球队的主场球衣主色 ─────────────────────
  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    const f = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + f(r) + f(g) + f(b);
  }
  function relLum(c) {
    const s = [c.r, c.g, c.b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  }
  function mixHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    if (!A || !B) return a;
    return rgbToHex(A.r + (B.r - A.r) * t, A.g + (B.g - A.g) * t, A.b + (B.b - A.b) * t);
  }
  function themeFor(clubId) {
    const c = FW.state.clubs && FW.state.clubs[clubId];
    const colors = (c && c.colors) || {};
    let primary = colors.primary || '#2F4858';
    let rgb = hexToRgb(primary) || { r: 47, g: 72, b: 88 };
    // 白/浅色球衣不适合直接当主题色：压暗到可读范围
    if (relLum(rgb) > 0.62) primary = mixHex(primary, '#1b2028', 0.62);
    if (relLum(hexToRgb(primary) || rgb) < 0.045) primary = mixHex(primary, '#ffffff', 0.32);
    rgb = hexToRgb(primary) || rgb;
    const ink = relLum(rgb) > 0.33 ? '#1b2028' : '#ffffff';
    return {
      primary,
      deep: mixHex(primary, '#151a21', 0.42),
      soft: mixHex(primary, '#ffffff', 0.82),
      wash: 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.055)',
      wash2: 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.10)',
      line: 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.20)',
      ink,
      onPrimary: ink,
    };
  }
  function applyClubTheme(clubId) {
    const t = themeFor(clubId);
    const root = document.documentElement;
    root.style.setProperty('--club-primary', t.primary);
    root.style.setProperty('--club-deep', t.deep);
    root.style.setProperty('--club-soft', t.soft);
    root.style.setProperty('--club-wash', t.wash);
    root.style.setProperty('--club-wash2', t.wash2);
    root.style.setProperty('--club-line', t.line);
    root.style.setProperty('--club-ink', t.onPrimary);
    root.dataset.clubTheme = clubId || '';
  }
  // ── 赛事赛徽主色 ────────────────────────────────────────────────────
  const COMP_COLORS={
    UCL:{primary:'#12236B',soft:'#2B4BB5'},
    UEL:{primary:'#F07B1D',soft:'#F5A85B'},
    UECL:{primary:'#00954A',soft:'#3DBE7C'},
    ACLE:{primary:'#0E7FC1',soft:'#43A9DE'},
    ACL2:{primary:'#0B7A63',soft:'#3FA691'},
    LIB:{primary:'#0C8F4A',soft:'#3FB877'},
    SUD:{primary:'#12408F',soft:'#3C6DC4'},
    CWC:{primary:'#B8912A',soft:'#D9B44A'}
  };
  function compVars(compId){
    const c=COMP_COLORS[compId]||{primary:'#202328',soft:'#4a5160'};
    return '--cx1:'+c.primary+';--cx2:'+c.soft+';';
  }
  // ── 国旗主色 ────────────────────────────────────────────────────────
  const FLAG_COLORS={
    '中国':['#C8102E','#F2C200'],'日本':['#BC002D','#FFFFFF'],'韩国':['#003478','#C8102E'],
    '沙特阿拉伯':['#006C35','#FFFFFF'],'法国':['#0055A4','#EF4135'],'英格兰':['#FFFFFF','#C8102E'],
    '苏格兰':['#005EB8','#FFFFFF'],'威尔士':['#C8102E','#00B140'],'德国':['#111111','#DD0000'],
    '西班牙':['#C8102E','#FFC400'],'意大利':['#008C45','#CD212A'],'葡萄牙':['#046A38','#DA291C'],
    '荷兰':['#AE1C28','#21468B'],'比利时':['#111111','#FDDA24'],'巴西':['#009C3B','#FFDF00'],
    '阿根廷':['#74ACDF','#FFFFFF'],'乌拉圭':['#0038A8','#FCD116'],'哥伦比亚':['#FCD116','#003893'],
    '智利':['#D52B1E','#0039A6'],'秘鲁':['#D91023','#FFFFFF'],'厄瓜多尔':['#FFD100','#034EA2'],
    '巴拉圭':['#D52B1E','#0038A8'],'墨西哥':['#006847','#CE1126'],'美国':['#3C3B6E','#B22234'],
    '加拿大':['#D80621','#FFFFFF'],'摩洛哥':['#C1272D','#006233'],'塞内加尔':['#00853F','#FDEF42'],
    '尼日利亚':['#008751','#FFFFFF'],'埃及':['#CE1126','#111111'],'喀麦隆':['#007A5E','#CE1126'],
    '加纳':['#006B3F','#FCD116'],'科特迪瓦':['#F77F00','#009E60'],'阿尔及利亚':['#006233','#D21034'],
    '突尼斯':['#E70013','#FFFFFF'],'澳大利亚':['#00008B','#FFCD00'],'伊朗':['#239F40','#DA0000'],
    '土耳其':['#E30A17','#FFFFFF'],'克罗地亚':['#171796','#FF0000'],'塞尔维亚':['#C6363C','#0C4076'],
    '捷克':['#11457E','#D7141A'],'奥地利':['#ED2939','#FFFFFF'],'瑞士':['#D52B1E','#FFFFFF'],
    '丹麦':['#C60C30','#FFFFFF'],'挪威':['#BA0C2F','#00205B'],'瑞典':['#006AA7','#FECC00'],
    '希腊':['#0D5EAF','#FFFFFF'],'俄罗斯':['#0039A6','#D52B1E'],'乌克兰':['#0057B7','#FFD700'],
    '卡塔尔':['#8A1538','#FFFFFF'],'阿联酋':['#00732F','#FF0000'],'伊拉克':['#007A3D','#CE1126'],
    '乌兹别克斯坦':['#1EB53A','#0099B5'],'越南':['#DA251D','#FFFF00'],'泰国':['#A51931','#2D2A4A']
  };
  function flagVars(country){
    let c=FLAG_COLORS[country];
    if(!c){
      const h=hash(String(country||'x'));
      c=['hsl('+(h%360)+',42%,42%)','hsl('+((h>>3)%360)+',36%,58%)'];
    }
    return '--fx1:'+c[0]+';--fx2:'+c[1]+';';
  }
  function clubVars(clubId){
    const c=FW.state.clubs&&FW.state.clubs[clubId];
    const k=(c&&c.colors)||{};
    return '--c1:'+(k.primary||'#2F4858')+';--c2:'+(k.secondary||'#F4F5F7');
  }
  function clubDot(clubId){return '<i class="club-dot" style="'+clubVars(clubId)+'"></i>';}
  function shell(body){const back=(view==='home'&&!viewStack.length)?'':`<button class="back-button glass-interactive" data-back="1" aria-label="返回上一页"><span>‹</span> 返回</button>`;app.innerHTML=`<div class="fw-page"><div class="shell">${back}<header class="top"><div><div class="brand">FOOTBALL WORLD</div><div class="date">WORLD TIME · ${FW.state.date}</div></div><div class="pill">${FW.state.season} · ${FW.state.matches.length} MATCHES PLAYED</div></header>${nav()}${body}<div class="footer-note">A living football world · lightweight simulation</div></div></div>`;bind();paintCareerLayer()}
let __lastAchCount=0;
  // ── 名人堂（localStorage，跨生涯保留）────────────────────────────────
  function readHallOfFame(){
    try{const raw=localStorage.getItem('fw_hof');const arr=raw?JSON.parse(raw):[];return Array.isArray(arr)?arr:[]}catch(e){return []}
  }
  function pushHallOfFame(summary){
    try{
      const arr=readHallOfFame();
      arr.unshift({name:summary.name,nationality:summary.nationality,position:summary.position,retiredAt:summary.retiredAt,seasons:summary.seasons,apps:summary.apps,goals:summary.goals,assists:summary.assists,grade:summary.grade,achievements:(summary.achievements||[]).length});
      localStorage.setItem('fw_hof',JSON.stringify(arr.slice(0,20)));
    }catch(e){}
  }
  function showRetireSummary(summary){
    const medal={传奇:'🥇',巨星:'🥈',名将:'🥉'}[summary.grade]||'🎖️';
    const layer=document.createElement('div');
    layer.className='career-layer retire-layer';
    const honours=(summary.honours||[]).slice(-6).map(h=>'<div class="row"><span>'+esc(h.season)+'</span><b>'+esc(h.text)+'</b></div>').join('');
    const achs=(summary.achievements||[]).map(a=>'<span class="badge" style="margin:2px 4px 2px 0">'+(a.icon||'🏅')+' '+esc(a.name)+'</span>').join('');
    layer.innerHTML='<div class="focus-backdrop"></div><div class="focus-dialog" role="dialog" aria-modal="true"><div class="focus-kicker">CAREER COMPLETE</div><div class="focus-icon">'+medal+'</div><h2>'+esc(summary.name)+' 的职业生涯</h2><p class="focus-lead">'+esc(summary.position)+' · '+esc(summary.nationality)+' · 退役年龄 '+summary.age+' 岁 · 评级 <b>'+esc(summary.grade)+'</b></p>'
      +'<div class="row"><span>效力赛季</span><b>'+summary.seasons+'</b></div>'
      +'<div class="row"><span>总出场</span><b>'+summary.apps+'（首发 '+summary.starts+'）</b></div>'
      +'<div class="row"><span>进球 / 助攻</span><b>'+summary.goals+' / '+summary.assists+'</b></div>'
      +'<div class="row"><span>国家队</span><b>'+summary.caps+' 场 · '+summary.nationalGoals+' 球</b></div>'
      +'<div class="row"><span>能力峰值</span><b>CA '+summary.peakCA+'</b></div>'
      +(honours?'<div class="section-head" style="margin-top:14px"><div><h3 style="font-size:14px">荣誉</h3></div></div>'+honours:'')
      +(achs?'<div class="section-head" style="margin-top:14px"><div><h3 style="font-size:14px">成就</h3></div></div><div>'+achs+'</div>':'')
      +'<div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-new-career="1">开始新生涯</button><button class="btn" data-close-retire="1">留在这个世界</button></div></div>';
    document.body.appendChild(layer);
    layer.querySelector('[data-new-career]').onclick=()=>{try{location.reload()}catch(e){}};
    layer.querySelector('[data-close-retire]').onclick=()=>layer.remove();
  }
  function paintCareerLayer(){
    document.querySelectorAll('.career-layer:not(.retire-layer)').forEach(x=>x.remove());
    const pl=FW.state&&FW.state.player;if(!pl||!pl.career)return;
    const c=pl.career;
    const ev=(c.pendingEvents||[])[0];
    const rep=(c.report&&c.reportDismissed!==c.report.season)?c.report:null;
    const cnt=Object.keys(c.achievements||{}).length;
    if(!ev&&!rep){
      if(cnt>__lastAchCount&&__lastAchCount>0){
        const keys=Object.keys(c.achievements||{});
        const last=keys[keys.length-1];
        const def=(FW.ACHIEVEMENTS||[]).find(a=>a.id===last);
        if(def){
          if(typeof FWSound!=='undefined')FWSound.play('unlock');
          const t=document.createElement('div');
          t.className='ach-toast';
          t.innerHTML='<span style="font-size:20px">'+(def.icon||'🏅')+'</span><div><div style="font-weight:700;font-size:13px">解锁成就：'+esc(def.name)+'</div><div class="subtle" style="font-size:11px">'+esc(def.desc||'')+'</div></div>';
          t.style.cssText='position:fixed;right:20px;bottom:20px;z-index:9999;display:flex;gap:10px;align-items:center;background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 8px 30px rgba(0,0,0,.16);';
          document.body.appendChild(t);
          setTimeout(()=>t.remove(),4200);
        }
      }
      __lastAchCount=cnt;
      return;
    }
    __lastAchCount=cnt;
    const layer=document.createElement('div');
    layer.className='career-layer';
    if(ev){
      const opts=ev.options.map(o=>'<button class="btn" data-event-option="'+esc(o.key)+'" data-event-id="'+esc(ev.id)+'">'+esc(o.label)+'</button>').join('');
      if(typeof FWSound!=='undefined')FWSound.play('select');
      layer.innerHTML='<div class="focus-backdrop"></div><div class="focus-dialog" role="dialog" aria-modal="true"><div class="focus-kicker">CAREER EVENT</div><div class="focus-icon">✦</div><h2>'+esc(ev.title)+'</h2><p class="focus-lead">'+esc(ev.body)+'</p><div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">'+opts+'</div></div>';
    }else{
      const d=(v)=>v==null?' · 首个赛季':(v>0?' ('+'+'+v+')':v<0?' ('+v+')':' (±0)');
      let rows='<div class="row"><span>出场</span><b>'+rep.apps+d(rep.deltaApps)+'</b></div>'
        +'<div class="row"><span>进球</span><b>'+rep.goals+d(rep.deltaGoals)+'</b></div>'
        +'<div class="row"><span>助攻</span><b>'+rep.assists+'</b></div>'
        +'<div class="row"><span>平均评分</span><b>'+rep.rating+d(rep.deltaRating)+'</b></div>';
      if((rep.objectives||[]).length){
        rows+='<div class="section-head" style="margin-top:14px"><div><h3 style="font-size:14px">目标回顾</h3></div></div>';
        rows+=rep.objectives.map(o=>'<div class="row"><span>'+esc(o.title)+'</span><b>'+(o.status==='done'?'达成':'未达成')+'</b></div>').join('');
      }
      if(typeof FWSound!=='undefined')FWSound.play('season');
      layer.innerHTML='<div class="focus-backdrop"></div><div class="focus-dialog" role="dialog" aria-modal="true"><div class="focus-kicker">SEASON REPORT</div><div class="focus-icon">🏁</div><h2>'+esc(rep.season)+' 赛季总结</h2><p class="focus-lead">目标完成度评级：<b>'+esc(rep.grade||'—')+'</b> · 表现评估：'+esc(rep.comment||'—')+'</p>'+rows+'<div style="margin-top:18px"><button class="btn primary" data-report-close="1">继续职业生涯</button></div></div>';
    }
    document.body.appendChild(layer);
    layer.querySelectorAll('[data-event-option]').forEach(b=>{b.onclick=()=>{const r=FW.resolveCareerEvent(b.dataset.eventId,b.dataset.eventOption);if(r&&r.ok)alert(r.reply||'已选择');paintCareerLayer();render()}});
    const close=layer.querySelector('[data-report-close]');
    if(close)close.onclick=()=>{c.reportDismissed=c.report.season;layer.remove()};
  }
  
  function home(){const p=FW.state.player;const __extra=(function(){const p=FW.state.player;if(!p||!p.career)return '';
      const snap=FW.careerSnapshot?FW.careerSnapshot(p):null;
      const items=(snap&&snap.objectives&&snap.objectives.items)||[];
      let objRows='';
      if(!items.length)objRows='<div class="empty">推进时间后会生成赛季目标</div>';
      else objRows=items.map(o=>{
        const v=typeof o.progress==='number'?o.progress:0;
        const t=o.target||1;
        const pct=typeof o.progressPct==='number'?Math.max(0,Math.min(100,Math.round(o.progressPct))):Math.max(0,Math.min(100,t?Math.round(v/t*100):0));
        const done=o.status==='done';
        const txt=done?'已达成':(o.metric==='clubRank'?('第 '+v+' 名'):(Math.round(v*10)/10+' / '+t));
        return '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:8px"><span>'+esc(o.title)+'</span><b style="color:'+(done?'#1a7f47':'#4a5568')+'">'+txt+'</b></div><div style="height:6px;background:#eef0f3;border-radius:99px;overflow:hidden;margin-top:5px"><div style="height:100%;width:'+pct+'%;background:'+(done?'#2fa36b':'var(--club-primary,#4a7dfc)')+'"></div></div></div>';
      }).join('');
      let hofRows='';
      try{
        const hof=JSON.parse(localStorage.getItem('fw_hof')||'[]');
        if(Array.isArray(hof)&&hof.length){
          hofRows='<section class="card"><div class="section-head"><div><div class="eyebrow">HALL OF FAME</div><h3>名人堂</h3></div><span class="badge">'+hof.length+' 位</span></div>'
            +hof.slice(0,3).map(h=>'<div class="notice" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:10px"><b>'+esc(h.name)+'</b><span class="badge">'+esc(h.grade||'—')+'</span></div><div class="subtle" style="margin-top:5px">'+esc(h.position||'')+' · '+esc(h.retiredAt||'')+' 退役 · '+h.seasons+' 个赛季 · '+h.apps+' 场 '+h.goals+' 球</div></div>').join('')
            +'</section>';
        }
      }catch(e){}
      const quickLinks='<div class="quick-row"><button class="btn" data-goto-tab="goals">目标与成就</button><button class="btn" data-v="matches">比赛回放</button><button class="btn" data-v="world">联赛与射手榜</button><button class="btn" data-help="1">快捷键</button></div>';
      const media=(snap&&snap.media)||[];
      let mediaRows='<div class="empty">推进时间后会出现媒体消息</div>';
      if(media.length)mediaRows=media.slice(0,5).map(m=>'<div class="notice" style="margin-bottom:8px"><b>'+esc(m.headline)+'</b><div class="subtle" style="margin-top:4px">'+esc(m.body)+'</div><div class="subtle" style="margin-top:4px;font-size:11px">'+esc(m.date)+'</div></div>').join('');
      const pending=(p.career&&p.career.pendingEvents&&p.career.pendingEvents.length)||0;
      return quickLinks+'<section class="card"><div class="section-head"><div><div class="eyebrow">OBJECTIVES</div><h3>本赛季目标</h3></div><button class="btn" data-v="player" data-goto-tab="goals">查看全部</button></div>'+objRows+'</section>'
        +hofRows+'<section class="card"><div class="section-head"><div><div class="eyebrow">NEWSROOM</div><h3>最新消息</h3></div>'+(pending?'<span class="badge" style="background:#fff3e0;color:#b26a00">有 '+pending+' 件事等你决定</span>':'')+'</div>'+mediaRows+'</section>';
    })();return `<div class="grid"><section class="card hero-card" ${p?`style="${clubVars(p.clubId)}"`:""}>${p?'<div class="card-accent"></div>':''}<div class="hero"><div class="avatar">${p?esc(p.name[0]):'FW'}</div><div><div class="eyebrow">${p?'YOUR CAREER':'WELCOME'}</div><div class="title">${p?playerNameHTML(p):'Football World'}</div><div class="muted">${p?`${p.position} · ${p.age}岁 · ${esc(FW.clubName(p.clubId))} · ${({youth:'青训',academy:'学院', 'early-career':'职业初期',prime:'巅峰', 'late-prime':'后巅峰',veteran:'老将','retirement-window':'退役窗口'}[FW.careerStage(p)]||'职业球员')}`:'一个从零开始的足球世界。'}</div></div></div><div class="actions"><button class="btn primary" data-v="${p?'player':'player'}">${p?'进入我的球员':'创建我的球员'}</button><button class="btn" data-v="world">浏览世界</button><button class="btn" data-v="matches">最新比赛</button></div></section>${nextMatchCard()}${__extra}<section class="card half"><div class="section-head"><div><div class="eyebrow">SEASON ${FW.state.season}</div><h3>本赛季</h3></div></div><div class="row"><span>赛季结束</span><b>${FW.state.seasonEnd||'—'}</b></div><div class="row"><span>已完成比赛</span><b>${FW.state.matches.length}</b></div>${FW.state.seasons.length?`<div class="notice" style="margin-top:14px">上赛季冠军：${FW.state.seasons[FW.state.seasons.length-1].champions?.map(x=>esc(FW.clubName(x.clubId))).join(' · ')||'—'}</div>`:'<div class="notice" style="margin-top:14px">这是你的第一个赛季。推进时间，等赛季结束后会产生冠军与升降级。</div>'}</section><section class="card half"><div class="section-head"><div><div class="eyebrow">WORLD</div><h3>世界规模</h3></div></div><div class="kpi"><div class="k"><b>${FW.state.leagues.length}</b><span>联赛</span></div><div class="k"><b>${Object.keys(FW.state.clubs).length}</b><span>俱乐部</span></div><div class="k"><b>${Object.keys(FW.state.players).length}</b><span>球员</span></div></div></section><section class="card half"><div class="section-head"><div><div class="eyebrow">NEXT</div><h3>现在做什么</h3></div></div><div class="notice">${p?`选择训练方向，或推进时间让比赛自然发生。${(()=>{const n=FW.state.fixtures.filter(f=>f.status==='scheduled'&&(f.homeClubId===p.clubId||f.awayClubId===p.clubId)).sort((a,b)=>a.date.localeCompare(b.date))[0];return n?`<br><br>下一场：${esc(FW.clubName(n.homeClubId))} vs ${esc(FW.clubName(n.awayClubId))} · ${n.date}`:''})()}`:'创建球员后，你的人生和世界时间会一起开始。'}</div></section></div>`}
  function playerMatchRow(r){
    try{
      r=r||{}; const score=(r.score&&typeof r.score==='object')?r.score:{};
      const home=Number.isFinite(Number(score.home))?Number(score.home):0, away=Number.isFinite(Number(score.away))?Number(score.away):0;
      const clubName=FW.clubName(r.clubId), oppName=FW.clubName(r.opponentClubId);
      const result=home>away?'胜':home<away?'负':'平';
      const status=r.status==='starter'?'首发':r.status==='substitute'?'替补':r.status==='unused'?'未出场':'—';
      const rating=r.rating==null?'—':Number(r.rating).toFixed(1);
      return `<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><b>${esc(r.date||'—')} · ${esc(r.competition||FW.leagueName(r.leagueId)||'比赛')}</b><div class="subtle" style="margin-top:5px">${esc(clubName)} ${home}-${away} ${esc(oppName)}</div></div><span class="badge">${result}</span></div><div class="subtle" style="margin-top:8px">${status} · ${Number(r.minutes)||0} 分钟 · 评分 ${rating} · ${Number(r.goals)||0} 球 · ${Number(r.assists)||0} 助攻</div></div>`;
    }catch(e){ console.error('playerMatchRow',e); return '<div class="notice">这场比赛记录暂时无法显示，但不会影响你的职业生涯。</div>'; }
  }

  // 球员「照片 + 关键信息」卡：2D 端与 3D 外观同源（同一个 playerId → 同一张脸），
  // 但卡片只放玩家关心的信息（国籍/位置/能力/身价/荣誉/本赛季），不再罗列脸型/体型等建模参数。
  // 俱乐部主色 → 头像球衣色
  function clubJerseyFor(p){
    try{
      const c=p&&FW.state.clubs[p.clubId];
      const cc=c&&c.colors&&c.colors.primary;
      if(!cc)return 0x2f5e42;
      const n=parseInt(String(cc).replace('#',''),16);
      return isFinite(n)?n:0x2f5e42;
    }catch(e){return 0x2f5e42}
  }

  // 球员概览卡：左头像 + 右侧信息行（沿用原来的排版），内容只放玩家关心的东西：
  // 国籍 / 效力俱乐部 / 位置 / 年龄 / 能力 / 身价 / 荣誉 / 本赛季。
  // 脸型、体型、胡须这些建模参数属于开发信息，不再展示。
  function profileLookCard(p,opt){
    try{
      const o=opt||{};
      if(!p)return '';
      const AV=window.FWAvatar;
      const svg=(AV&&AV.svg)?AV.svg(p,{size:104,jersey:clubJerseyFor(p)}):'';
      const club=FW.state.clubs[p.clubId];
      const lg=club&&(FW.state.leagues||[]).find(function(l){return l.id===club.leagueId});
      const hon=p.honours||[];
      const recent=hon.slice(-2).map(function(x){return String(x.name||x.leagueName||x.type||'').trim()}).filter(Boolean);
      const honTxt=hon.length?(hon.length+' 项'+(recent.length?' · '+recent.join(' · '):'')):'—';
      const ss=p.seasonStats||{};
      const stats=p.stats||{};
      const statNames={speed:'速度',shooting:'射门',passing:'传球',control:'控球',defense:'防守',stamina:'体能'};
      let bestK='',bestV=-1;
      for(const k in stats){const v=Number(stats[k]);if(v>bestV){bestV=v;bestK=k}}
      const caps=(p.nationalTeam&&p.nationalTeam.caps)||0;
      const nt=(FW.nationalTeamForPlayer&&FW.nationalTeamForPlayer(p))||null;
      const rows=[
        ['国籍',esc(p.nationality||'—')],
        ['效力俱乐部',esc(club?club.name:'自由球员')+(lg?' · '+esc(lg.name):'')],
        ['位置',esc(posLabel(p.position))+'（'+esc(p.position||'—')+'）'],
        ['年龄',(p.age||'—')+' 岁'],
        ['能力','CA '+(p.ca||'—')+' / PA '+(p.pa||'—')+(bestK?' · 强项 '+(statNames[bestK]||bestK)+' '+Math.round(bestV):'')],
        ['身价',p.marketValue?('€'+Number(p.marketValue).toLocaleString()):'—'],
        ['荣誉',esc(honTxt)],
        ['本赛季',(ss.appearances||0)+' 场 · '+(ss.goals||0)+' 球 · '+(ss.assists||0)+' 助'],
        ['国家队',esc(nt?nt.name:'—')+' · '+caps+' 次出场']
      ];
      // 头像位：渲染时就绪就内联；否则留一个带球员 id 的占位符，由 index.html 的桥接脚本在模块就绪后填充
      const avatarSlot='<span class="fw-avatar-slot" data-fw-pid="'+esc(String(p.id||''))+'" style="flex:0 0 auto;display:block">'+(svg||'')+'</span>';
      return '<div class="fw-snap-card">'
        +avatarSlot
        +'<div style="flex:1;min-width:0">'
        +'<div class="eyebrow" style="margin-bottom:4px">PLAYER SNAPSHOT · 球员概览</div>'
        +rows.map(function(r){return '<div class="fw-snap-row"><span>'+r[0]+'</span><b>'+r[1]+'</b></div>'}).join('')
        +'</div></div>';
    }catch(e){return ''}
  }

  function player(){const p=FW.state.player;if(!p)return createPlayer();const lookCard=profileLookCard(p,{});const tabs=[['overview','总览'],['goals','目标'],['training','训练'],['matches','比赛'],['career','职业'],['ability','能力']];const trainPv=FW.trainingPreview?FW.trainingPreview(p):null;const potInfo=FW.potentialInfo?FW.potentialInfo(p):null;let content='';if(playerTab==='overview')content=`<div class="kpi"><div class="k"><b>${p.ca}</b><span>当前能力 CA</span></div><div class="k"><b>${potInfo?potInfo.low+"–"+potInfo.high:p.pa}</b><span>潜力区间（球探）</span></div><div class="k"><b>${p.age}</b><span>年龄</span></div></div>${p.injury?`<div class="notice" style="margin-top:12px;border-left:3px solid #e05353"><b>伤停中：${p.injury.name}</b><div class="subtle" style="margin-top:5px">还需 ${p.injury.daysLeft} 天恢复（${p.injury.severity}伤），期间无法出场，训练只建议「休息」。</div></div>`:''}${lookCard}<div class="row"><span>职业阶段</span><b>${({youth:'青训',academy:'学院', 'early-career':'职业初期',prime:'巅峰', 'late-prime':'后巅峰',veteran:'老将','retirement-window':'退役窗口'}[FW.careerStage(p)]||'职业球员')}</b></div><div class="row"><span>职业状态</span><b>${p.careerLifecycle?.status==='retirement-window'?'接近退役':'现役'}</b></div><div class="row"><span>潜力兑现</span><b>${potInfo?potInfo.pct+"%":'—'} · ${potInfo?esc(potInfo.verdict):''}</b></div><div class="row"><span>当前身价</span><b>€${(p.marketValue||0).toLocaleString()}</b></div><div class="row"><span>俱乐部</span><b>${esc(FW.clubName(p.clubId))}</b></div><div class="row"><span>俱乐部余额</span><b>€${(FW.clubFinance(p.clubId)?.balance||0).toLocaleString()}</b></div><div class="row"><span>工资支出 / 周</span><b>€${(FW.clubFinance(p.clubId)?.weeklyWageBill||0).toLocaleString()}</b></div><div class="row"><span>转会预算</span><b>€${(FW.clubFinance(p.clubId)?.transferBudget||0).toLocaleString()}</b></div>${(()=>{const m=FW.clubProfile(p.clubId);return m?`<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">CLUB</div><h3>俱乐部环境</h3></div></div><div class="row"><span>俱乐部定位</span><b>${esc(m.identity)}</b></div><div class="row"><span>主教练</span><b>${esc(m.coach.name)} · ${esc(m.coach.style)}</b></div><div class="row"><span>球队阵型</span><b>${esc(m.tactics?.formation||'4-3-3')} · ${esc(m.tactics?.style||'平衡')}</b></div><div class="row"><span>俱乐部声望</span><b>${Math.round(m.reputation)}</b></div><div class="row"><span>主场</span><b>${esc(m.stadium?.name||'—')} · ${m.stadium?.capacity?.toLocaleString()||'—'} 座</b></div>${m.city?`<div class="row"><span>所在城市</span><b>${esc(m.city)}</b></div>`:''}<div class="row"><span>青训体系</span><b>Lv.${m.academy.level} · ${esc(m.academy.id||'—')}</b></div>`:''})()}<div class="row"><span>位置</span><b>${p.position}</b></div><div class="row"><span>国籍</span><b>${esc(p.nationality)}</b></div><div class="row"><span>所属足协</span><b>${esc(FW.countrySystem(p.nationality)?.federation?.name||'—')}</b></div><div class="row"><span>国家队</span><b>${esc(FW.nationalTeamForPlayer(p)?.name||'—')} · ${p.nationalTeam?.caps||0} 次出场</b></div><div class="row"><span>足球文化</span><b>${esc(FW.COUNTRY_PROFILES[p.nationality]?.style||'综合型')}</b></div><div class="row"><span>体能 / 士气 / 疲劳</span><b>${Math.round(p.fitness)} / ${Math.round(p.morale)} / ${Math.round(p.fatigue)}</b></div><div class="row"><span>本赛季出场 / 进球 / 助攻</span><b>${p.seasonStats?.appearances||0} / ${p.seasonStats?.goals||0} / ${p.seasonStats?.assists||0}</b></div><div class="row"><span>平均评分</span><b>${p.seasonStats?.appearances?(p.seasonStats.avgRating||0).toFixed(2):'—'}</b></div><div class="row"><span>教练信任</span><b>${Math.round(p.development?.coachTrust??45)} · ${p.development?.role==='key player'?'核心球员':p.development?.role==='regular'?'常规主力':p.development?.role==='rotation'?'轮换球员':'边缘球员'}</b></div>${p.careerLifecycle?`<div class="row"><span>出场时间</span><b>${p.careerLifecycle.playingTime||'评估中'} · 首发率 ${p.careerLifecycle.startRate||0}%</b></div><div class="row"><span>职业下一步</span><b>${esc(p.careerLifecycle.nextStep||'争取更多机会')}</b></div>`:''}${(()=>{const r=FW.playerRelationships(p);return `<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">RELATIONSHIPS</div><h3>人际关系</h3></div></div><div class="kpi"><div class="k"><b>${Math.round(r.coachTrust)}</b><span>教练信任</span></div><div class="k"><b>${Math.round(r.teamChemistry)}</b><span>队友默契</span></div><div class="k"><b>${Math.round(r.clubLoyalty)}</b><span>俱乐部忠诚</span></div></div><div class="row"><span>经纪人信任</span><b>${Math.round(r.agentTrust)}</b></div><div class="row"><span>媒体声誉</span><b>${Math.round(r.mediaReputation)}</b></div><div class="row"><span>球迷支持</span><b>${Math.round(r.fanSupport)}</b></div>`})()}<div style="margin-top:15px" class="notice">你的首发与替补机会会受到能力、状态、体能、近期表现和教练信任影响。表现好会逐步获得更多机会，长期表现不佳或缺少比赛可能降低球队地位。</div>`;else if(playerTab==='training')content=`<div class="section-head"><div><div class="eyebrow">DEVELOPMENT</div><h3>训练</h3></div>${trainPv?`<span class="badge">当前效率 ${trainPv.efficiency.toFixed(2)}×</span>`:''}</div>
      <div class="train-state">
        <div class="ts-item"><span>疲劳</span><div class="meter"><i style="width:${Math.max(0,Math.min(100,trainPv?trainPv.fatigue:0))}%"></i></div><b>${trainPv?trainPv.fatigue:0}</b></div>
        <div class="ts-item"><span>体能</span><div class="meter"><i style="width:${Math.max(0,Math.min(100,trainPv?trainPv.fitness:0))}%"></i></div><b>${trainPv?trainPv.fitness:0}</b></div>
        <div class="ts-item"><span>士气</span><div class="meter"><i style="width:${Math.max(0,Math.min(100,trainPv?trainPv.morale:0))}%"></i></div><b>${trainPv?trainPv.morale:0}</b></div>
      </div>
      <p class="subtle" style="margin:6px 0 0">疲劳越高、体能越低，单次训练涨幅越小；年龄决定成长上限（20 岁以前最快，29 岁后明显变慢）。</p><p class="subtle" style="margin:4px 0 0">${potInfo?`距离潜力上限还差 ${potInfo.gap}（兑现 ${potInfo.pct}%）；按当前状态每年约 +${potInfo.perYear}。出场时间越多，训练兑现率越高（当前 ${Math.round(potInfo.exposure*100)}%）。`:""}</p>
      ${trainPv&&trainPv.injured?`<div class="notice warn" style="margin-top:12px"><b>受伤中：${esc(trainPv.injured.name)}</b><div class="subtle" style="margin-top:4px">预计还需 ${trainPv.injured.daysLeft} 天恢复，期间无法训练，只能推进时间或比赛。</div></div>`:''}
      ${trainPv&&trainPv.trainedToday?`<div class="notice" style="margin-top:12px">今天已经完成一次训练。推进时间到下一场比赛或下一天后可以再次训练。</div>`:''}
      <div class="section-head" style="margin-top:18px"><div><div class="eyebrow">FOCUS</div><h3>训练方向</h3></div></div>
      <div class="train-options">${(trainPv?trainPv.options:[]).map(function(o){
        var disabled=(trainPv&&(trainPv.injured||trainPv.trainedToday));
        return '<button class="train-opt'+(disabled?' is-disabled':'')+'" data-train="'+o.key+'"'+(disabled?' disabled':'')+'>'
          +'<div class="to-top"><b>'+esc(o.label)+'</b><span class="to-gain">'+(o.min!=null?('每次 +'+o.min+'~'+o.max):'不涨属性')+'</span></div>'
          +'<div class="to-stats">'+(o.stats.length?o.stats.map(function(k){return '<span class="chip">'+esc(statLabels[k]||k)+'</span>'}).join(''):'<span class="chip">恢复</span>')+'</div>'
          +'<div class="to-desc">'+esc(o.desc)+'</div>'
          +'<div class="to-cost">疲劳 '+(o.fatigue>0?'+':'')+o.fatigue+' · 体能 '+(o.fitness>0?'+':'')+o.fitness+'</div>'
          +'</button>';
      }).join('')}</div>
      <p class="subtle" style="margin-top:8px">每次训练结算一次，收益落在左侧属性条上（内部按小数累计，页面显示整数）。</p>
      <div class="section-head" style="margin-top:20px"><div><div class="eyebrow">TRAINING PLAN</div><h3>训练计划</h3></div></div>
      ${FW.state.trainingPlan?`<div class="notice"><b>当前计划：${esc(FW.state.trainingPlan.type)} · ${FW.state.trainingPlan.days} 天</b><br><span class="subtle">已训练 ${FW.state.trainingPlan.trainedDays||0} 天 · 比赛日跳过 ${FW.state.trainingPlan.skippedMatchDays||0} 天 · 结束于 ${FW.state.trainingPlan.endDate}</span><div class="subtle" style="margin-top:6px">累计收益：${Object.keys(FW.state.trainingPlan.gains||{}).length?Object.entries(FW.state.trainingPlan.gains).map(function(e){return (statLabels[e[0]]||e[0])+' +'+e[1].toFixed(2)}).join(' · '):'暂无（比赛日跳过）'}</div><div class="actions" style="margin-top:12px"><button class="btn" data-stop-training-plan="1">停止计划</button></div></div>`:`<div class="plan-pick"><span class="subtle">先选方向，再选天数</span><div class="actions" style="margin-top:8px">${['技术','速度','射门','战术','身体','休息'].map(function(x){return '<button class="btn'+(window.__trainingPlanType===x?' primary':'')+'" data-plan-type="'+x+'">'+x+'</button>'}).join('')}</div><div class="actions" style="margin-top:8px">${[7,30,90].map(function(d){var t=window.__trainingPlanType;return '<button class="btn'+(t?' primary':'')+'" data-plan-days="'+d+'"'+(t?'':' disabled title="请先选择训练方向"')+'>'+d+' 天</button>'}).join('')}</div><p class="subtle" style="margin-top:8px">计划会每天自动训练一次，比赛日自动跳过；${window.__trainingPlanType?('当前选择：'+esc(window.__trainingPlanType)):'尚未选择方向（不选则无法开始）'}。</p></div>`}
${window.__lastTraining&&window.__lastTraining.type?`<div class="notice" style="margin-top:14px"><b>上一次训练：${esc(window.__lastTraining.type)}</b><div class="subtle" style="margin-top:4px">${Object.keys(window.__lastTraining.gains||{}).length?Object.entries(window.__lastTraining.gains).map(function(e){return (statLabels[e[0]]||e[0])+' +'+e[1].toFixed(2)}).join(' · '):'无属性变化'}${window.__lastTraining.status?` · 疲劳 ${window.__lastTraining.status.fatigue>0?'+':''}${window.__lastTraining.status.fatigue} · 体能 ${window.__lastTraining.status.fitness>0?'+':''}${window.__lastTraining.status.fitness}`:''}${window.__lastTraining.caDelta?` · CA ${window.__lastTraining.caDelta>0?'+':''}${window.__lastTraining.caDelta}`:''}</div></div>`:''}`;else if(playerTab==='matches'){
      const all=[...(p.matchHistory||[])].reverse();
      const ms=all.slice(0,12);
      const rated=all.filter(r=>r.minutes>0&&typeof r.rating==='number').slice(-16).map(r=>r.rating);
      const trend=rated.length>=2?`<div class="section-head"><div><div class="eyebrow">FORM</div><h3>近期评分走势</h3></div><span class="badge">${(rated.reduce((a,b)=>a+b,0)/rated.length).toFixed(2)} 平均</span></div><div class="spark-wrap">${sparkline(rated,{height:56})}</div>`:'';
      content=trend+(ms.length?ms.map(r=>playerMatchRow(r)).join(''):'<div class="empty">还没有你的比赛记录。<br>推进时间让俱乐部比赛自然发生。</div>');
    }else if(playerTab==='goals'){
      const snap=FW.careerSnapshot?FW.careerSnapshot(p):null;
      const objs=(snap&&snap.objectives)||{items:[]};
      const ach=(snap&&snap.achievements)||[];
      const achIds=new Set(ach.map(a=>a.id));
      const allAch=FW.ACHIEVEMENTS||[];
      const objsItems=objs.items||[];
      const objChip=(st)=>st==='done'?'<span class="badge" style="background:#e8f7ee;color:#1a7f47">已达成</span>':st==='failed'?'<span class="badge" style="background:#fdecec;color:#b3261e">未达成</span>':'<span class="badge">进行中</span>';
      const bar=(pct)=>'<div style="height:6px;background:#eef0f3;border-radius:99px;overflow:hidden;margin-top:6px"><div style="height:100%;width:'+pct+'%;background:'+(pct>=100?'#2fa36b':'#4a7dfc')+';border-radius:99px"></div></div>';
      const fmt=(v)=>Math.round(v*10)/10;
      const objHtml=objsItems.length?objsItems.map(o=>{
        const v=typeof o.progress==='number'?o.progress:0;
        const tv=o.target||1;
        const pct=typeof o.progressPct==='number'?Math.round(o.progressPct):0;
        const desc=o.metric==='clubRank'?('当前第 '+v+' 名 · 目标第 '+tv+' 名以内'):(fmt(v)+' / '+tv);
        return '<div class="notice" style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b>'+esc(o.title)+'</b>'+objChip(o.status)+'</div><div class="subtle" style="margin-top:5px">'+desc+(o.type==='club'?' · 俱乐部目标':'')+'</div>'+bar(pct)+'</div>';
      }).join(''):'<div class="empty">本赛季目标尚未生成</div>';
      const achHtml=allAch.map(a=>{
        const got=achIds.has(a.id);
        return '<div title="'+esc(a.desc||'')+'" style="display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:10px;background:'+(got?'#eaf7f0':'#f6f7f9')+';opacity:'+(got?1:0.55)+'"><span style="font-size:18px">'+(a.icon||'🏅')+'</span><div style="min-width:0"><div style="font-weight:600;font-size:13px">'+esc(a.name)+'</div><div class="subtle" style="font-size:11px">'+(got?'已解锁':'未解锁')+'</div></div></div>';
      }).join('');
      content='<div class="section-head"><div><div class="eyebrow">SEASON '+esc(FW.state.season)+'</div><h3>本赛季目标</h3></div><span class="badge">'+objsItems.filter(o=>o.status==='done').length+'/'+objsItems.length+'</span></div>'+objHtml
        +'<div class="section-head" style="margin-top:22px"><div><div class="eyebrow">ACHIEVEMENTS</div><h3>成就墙</h3></div><span class="badge">'+ach.length+'/'+allAch.length+'</span></div>'
        +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">'+achHtml+'</div>'
        +(function(){
          const R=FW.careerRecords?FW.careerRecords(p):null;
          if(!R)return '';
          const tr=R.transfers.length?R.transfers.slice().reverse().map(function(t){
            const from=t.from?FW.clubName(t.from):'自由身';
            const to=t.to?FW.clubName(t.to):'离队';
            const fee=t.fee?('€'+(t.fee/1000000).toFixed(1)+'M'):'自由转会';
            return '<div class="rec-row"><span class="rec-date">'+esc(t.date||'')+'</span><span class="rec-main">'+esc(from)+' → '+esc(to)+'</span><span class="rec-tag">'+esc(fee)+'</span></div>';
          }).join(''):'<div class="empty">还没有转会记录</div>';
          const hn=R.honours.length?R.honours.slice().reverse().map(function(h){
            return '<div class="rec-row"><span class="rec-date">'+esc(h.season||'')+'</span><span class="rec-main">'+esc(h.name||h.type)+'</span><span class="rec-tag">'+esc(h.type)+'</span></div>';
          }).join(''):'<div class="empty">还没有荣誉</div>';
          return '<div class="section-head" style="margin-top:22px"><div><div class="eyebrow">CAREER RECORDS</div><h3>生涯纪录</h3></div><span class="badge">'+R.totals.honoursTotal+' 项荣誉</span></div>'
            +'<div class="kpi" style="margin-bottom:12px"><div class="k"><b>'+R.totals.apps+'</b><span>总出场</span></div><div class="k"><b>'+R.totals.goals+'</b><span>总进球</span></div><div class="k"><b>'+R.totals.assists+'</b><span>总助攻</span></div><div class="k"><b>'+R.totals.seasons+'</b><span>赛季数</span></div><div class="k"><b>'+R.totals.goalsPer90+'</b><span>每 90 分钟进球</span></div></div>'
            +'<div class="section-head" style="margin-top:10px"><div><div class="eyebrow">TRANSFERS</div><h3>转会轨迹</h3></div></div><div class="rec-list">'+tr+'</div>'
            +'<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">HONOURS</div><h3>荣誉室</h3></div></div><div class="rec-list">'+hn+'</div>';
        })()
    }
    else if(playerTab==='career'){const years=FW.contractYearsLeft(p);const offers=p.transferOffers||[];const history=[...(p.seasonHistory||[])].reverse();const transfers=(p.growthHistory||[]).filter(x=>x.type==='transfer').reverse();content=`<div class="section-head"><div><div class="eyebrow">CAREER</div><h3>合同</h3></div><button class="btn" data-briefing="1">球队介绍</button></div><div class="row"><span>当前俱乐部</span><b>${esc(FW.clubName(p.clubId))}</b></div><div class="row"><span>合同到期</span><b>${p.contract?.endDate||'—'}</b></div><div class="row"><span>剩余合同</span><b>${years.toFixed(1)} 年</b></div><div class="row"><span>周薪</span><b>€${(p.contract?.weeklyWage||0).toLocaleString()}</b></div><div class="row"><span>球队定位</span><b>${p.development?.role==='key player'?'核心球员':p.development?.role==='regular'?'常规主力':p.development?.role==='rotation'?'轮换球员':'边缘球员'}</b></div>${p.careerLifecycle?.transferRequest?'<div class="notice" style="margin-top:12px">你对出场时间不满意，经纪人正在评估转会选择。</div>':''}${p.careerEvent?`<div class="notice" style="margin-top:12px"><div class="eyebrow">CAREER EVENT</div><h3 style="margin:5px 0 7px">${esc(p.careerEvent.title)}</h3><div class="subtle">${esc(p.careerEvent.detail)}</div><div class="actions" style="margin-top:12px">${p.careerEvent.choices.map(c=>`<button class="btn primary" data-career-choice="${c.id}">${esc(c.label)}</button>`).join('')}</div></div>`:''}${p.agentPlan?`<div class="row"><span>经纪人计划</span><b>${esc(p.agentPlan.goal||'观察市场')}</b></div><div class="row"><span>经纪人状态</span><b>${esc(p.agentPlan.lastAction||'正常跟进')}</b></div>`:''}<div class="actions" style="margin-top:16px"><button class="btn primary" data-offers="1">寻找转会机会</button></div>${offers.length?`<div class="section-head" style="margin-top:20px"><div>
      <div class="eyebrow">TRANSFER MARKET</div><h3>收到的机会</h3></div></div>${offers.map(o=>`<div class="notice" style="margin-bottom:10px;${window.__selectedOfferClubId===o.clubId?'outline:2px solid rgba(0,122,255,.28);':''}"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><b>${esc(o.clubName)}</b><br><span class="subtle">${o.role==='regular'?'常规主力':'轮换球员'} · 周薪 €${(o.weeklyWage||0).toLocaleString()} · 转会费 €${(o.transferFee||0).toLocaleString()} · 合同至 ${o.endDate||'—'}</span><br><span class="subtle">来源：${o.type==='agent-interest'?'经纪人接洽':o.type==='market-request'?'转会市场主动申请':'市场机会'}</span></div><button class="btn" data-accept="${o.id}">接受</button></div></div>`).join('')}`:'<div class="empty" style="margin-top:16px">暂时没有转会机会。可以过一段时间后再次寻找。</div>'}<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">SEASON HISTORY</div><h3>赛季履历</h3></div></div>${history.length?history.map((h,i)=>`<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>${esc(h.season||'未知赛季')}</b><span class="subtle">${h.appearances||0} 场 · ${h.goals||0} 球 · ${h.assists||0} 助</span></div><div class="subtle" style="margin-top:6px">首发 ${h.starts||0} · ${h.minutes||0} 分钟 · 场均 ${h.appearances?(h.avgRating||0).toFixed(2):'—'}</div></div>`).join(''):'<div class="empty">还没有完整赛季履历。完成一个赛季后会自动归档。</div>'}<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">CLUB HISTORY</div><h3>俱乐部经历</h3></div></div>${transfers.length?transfers.map(x=>`<div class="notice" style="margin-bottom:10px">${esc(FW.clubName(x.fromClubId))} → ${esc(FW.clubName(x.toClubId))}<br><span class="subtle">${x.date}</span></div>`).join(''):'<div class="empty">目前只有当前俱乐部经历。</div>'}${(p.honours&&p.honours.length)?`<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">PERSONAL HONOURS</div><h3>个人荣誉</h3></div><span class="badge">${p.honours.length} 项</span></div>${p.honours.slice().reverse().map(h=>`<div class="notice" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:12px"><b>${esc(h.season)} · ${esc(h.leagueName)}${esc(h.type)}</b><span class="subtle">${h.value==null?'':esc(String(h.value))+(h.unit||'')}</span></div></div>`).join('')}`:''}<div class="section-head" style="margin-top:24px"><div><div class="eyebrow">WORLD HONOURS</div><h3>赛季荣誉</h3></div></div>${(FW.state.seasons||[]).length?FW.state.seasons.slice().reverse().slice(0,8).map(s=>{const h=history.find(x=>x.season===s.season);const clubIds=[...(h?.clubIds||[])];const results=[];for(const cid of clubIds){for(const lg of (s.standings||[])){const rank=(lg.table||[]).findIndex(x=>x.clubId===cid);if(rank>=0){const isChamp=rank===0;const movement=(s.movement||[]).find(m=>(m.relegated||[]).includes(cid)||(m.promoted||[]).includes(cid));const tags=[];if(isChamp)tags.push('联赛冠军');if(movement&&((movement.promoted||[]).includes(cid)))tags.push('升级');if(movement&&((movement.relegated||[]).includes(cid)))tags.push('降级');results.push(`${esc(lg.leagueName)} 第${rank+1}名${tags.length?' · '+tags.join(' · '):''}`)}}for(const cup of (s.cups||[])){if(cup.champion===cid)results.push(`${esc(cup.name)}冠军`);else if(cup.runnerUp===cid)results.push(`${esc(cup.name)}亚军`)}}const unique=[...new Set(results)];return `<div class="notice" style="margin-bottom:10px"><b>${esc(s.season)}</b> · ${unique.length?unique.join(' / '):'赛季成绩暂缺'} </div>`}).join(''):'<div class="empty">完成赛季后会产生完整联赛排名和荣誉。</div>'}<p class="subtle">转会会改变你的俱乐部环境，同时保留已有比赛与生涯记录。转会后教练信任需要重新建立。</p>`}else content=`<div class="radar-row"><div class="radar-box">${radarSVG(p.stats,180)}<div class="radar-cap">能力雷达</div></div><div class="stat-grid">${Object.entries(p.stats).map(([k,v])=>`<div class="stat"><div class="stat-top"><span>${statLabels[k]||k}</span><b>${Math.round(v)}</b></div><div class="meter"><i style="width:${Math.max(0,Math.min(100,v))}%"></i></div></div>`).join('')}</div></div>`;return `<div class="grid"><section class="card" style="${clubVars(p.clubId)}"><div class="card-accent"></div><div class="hero"><div class="avatar">${esc((p.nameZh||p.name||'球员')[0])}</div><div><div class="eyebrow">PLAYER PROFILE</div><h2 style="margin:6px 0">${playerNameHTML(p)}</h2><div class="muted">${p.position} · ${p.age}岁 · ${esc(FW.clubName(p.clubId))}</div></div></div><div class="tabs">${tabs.map(([k,t])=>`<button class="${playerTab===k?'active':''}" data-pt="${k}">${t}</button>`).join('')}</div>${content}${(function(){if(p.careerLifecycle&&p.careerLifecycle.status==='retired')return '<div class="notice" style="margin-top:18px"><b>已退役</b><div class="subtle" style="margin-top:6px">生涯结束于 '+esc(p.careerLifecycle.retiredDate||'')+'，共 '+((p.careerLifecycle.summary&&p.careerLifecycle.summary.seasons)||0)+' 个赛季。</div></div>';if(!(FW.canRetire&&FW.canRetire(p)))return '';return '<div class="notice retire-box" style="margin-top:18px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><div><b>结束职业生涯</b><div class="subtle" style="margin-top:4px">你已经 '+p.age+' 岁，可以在这里宣布退役并查看生涯总结。</div></div><button class="btn" data-retire="1">宣布退役</button></div></div>'})()}</section></div>`}
    function createPlayer(){
    const mode=window.__createMode||'new';
    const stageId=window.__createStage||'prospect';
    const stage=FW.stageById?FW.stageById(stageId):null;
    const nationality=window.__createNationality||Object.keys(FW.COUNTRY_PROFILES)[0];
    const nationOptions=Object.keys(FW.COUNTRY_PROFILES).map(x=>`<option value="${esc(x)}" ${x===nationality?'selected':''}>${esc(x)}</option>`).join('');
    const posOptions=FW.POS.map(x=>`<option value="${x}" ${x==='ST'?'selected':''}>${posLabel(x)} ${x}</option>`).join('');
    const stageCards=(FW.startStages?FW.startStages():[]).map(s=>`<button class="stage-card${s.id===stageId?' on':''}" data-create-stage="${s.id}">
        <div class="sc-top"><b>${esc(s.name)}</b><span class="sc-age">${esc(s.ageHint)}</span></div>
        <div class="sc-ca">CA ${s.caMin}–${s.caMax} · PA +${s.paBonus}</div>
        <div class="sc-desc">${esc(s.desc)}</div>
      </button>`).join('');
    const clubs=(FW.clubsForStage&&stage)?FW.clubsForStage(stageId,nationality):[];
    const clubOptions=clubs.map(c=>`<option value="${c.id}">${esc(c.name)} · 实力 ${Math.round(FW.clubStrength(c.id))}</option>`).join('');
    const leagueName=(()=>{const c=clubs[0];const l=c&&FW.state.leagues.find(x=>x.id===c.leagueId);return l?l.name+' · 第 '+(l.tier||1)+' 级':'—'})();
    const realMode=mode==='real';
    const realQuery=window.__realQuery||'';
    const realList=realMode&&FW.realPlayerCandidates?FW.realPlayerCandidates({q:realQuery,limit:30}):[];
    const realRows=realList.map(p=>`<div class="real-row"><div class="rr-main"><b>${esc(p.name)}</b> <span class="subtle">${esc(p.nameEn||'')}</span><div class="subtle">${esc(p.position)} · ${p.age}岁 · ${esc(p.nationality)} · ${esc(p.clubName)}</div></div><div class="rr-stat"><b>${p.ca}</b><span class="subtle">CA / PA ${p.pa}</span></div><button class="btn primary" data-real-pick="${esc(p.id)}">以他开局</button></div>`).join('');
    return `<div class="grid"><section class="card"><div class="eyebrow">NEW CAREER</div><h2>开始你的生涯</h2>
      <p class="muted">可以自己造一个球员，也可以直接接手现役的真实球员。</p>
      <div class="create-modes"><button class="btn${realMode?'':' primary'}" data-create-mode="new">新建球员</button><button class="btn${realMode?' primary':''}" data-create-mode="real">选择真实球员</button></div>
      ${realMode?`<div class="create-panel"><div class="form" style="max-width:none"><label>搜索真实球员<input class="input" id="realq" placeholder="输入名字、英文名或国籍" value="${esc(realQuery)}"></label></div><div class="real-list">${realRows||'<div class="empty">没有匹配的真实球员</div>'}</div><p class="subtle">用真实球员开局会继承他的能力、年龄、合同与俱乐部；原 NPC 占位会被移除，不会出现同名重复。</p></div>`
      :`<div class="create-panel">
        <div class="section-head" style="margin-top:6px"><div><div class="eyebrow">STAGE</div><h3>选择起步阶段</h3></div></div>
        <div class="stage-grid">${stageCards}</div>
        <div class="form" style="max-width:none;margin-top:14px">
          <label>姓名<input class="input" id="pn" value="新球员" maxlength="16"></label>
          <label>国籍<select class="select" id="pnat">${nationOptions}</select></label>
          <label>位置<select class="select" id="pp">${posOptions}</select></label>
          <label>俱乐部<select class="select" id="pc">${clubOptions}</select></label>
        </div>
        <div class="notice" style="margin-top:12px">起始联赛：${esc(leagueName)}<br>
          <span class="subtle">阶段决定年龄（${esc(stage?stage.ageHint:'')}）、初始能力区间（CA ${stage?stage.caMin:0}–${stage?stage.caMax:0}）与球队定位（${esc(stage?({youth:'轮换',prospect:'轮换',regular:'常规主力',star:'核心球员',veteran:'常规主力'}[stage.id]||'轮换'):'轮换')}）。能力越低起点越低，但成长空间越大。</span></div>
        <button class="btn primary" id="create" style="margin-top:14px">开始人生</button>
      </div>`}
    </section></div>`;
  }

  // 主客对阵条（首页下一场比赛）
  function nextMatchCard() {
    const p = FW.state.player;
    if (!p) return '';
    if (!p.clubId) return '<section class="card next-card"><div class="section-head"><div><div class="eyebrow">NEXT MATCH</div><h3>下一场比赛</h3></div></div><div class="empty">你目前没有俱乐部，等待经纪人安排。</div></section>';
    const fx = (FW.state.fixtures || []).find((f) => f.status === 'scheduled' && f.date >= FW.state.date && (f.homeClubId === p.clubId || f.awayClubId === p.clubId));
    if (!fx) return '<section class="card next-card"><div class="section-head"><div><div class="eyebrow">NEXT MATCH</div><h3>下一场比赛</h3></div></div><div class="empty">赛季已结束或暂无赛程，推进时间等待新赛季。</div></section>';
    const home = fx.homeClubId === p.clubId;
    const oppId = home ? fx.awayClubId : fx.homeClubId;
    const days = Math.max(0, Math.round((new Date(fx.date + 'T00:00:00Z') - new Date(FW.state.date + 'T00:00:00Z')) / 86400000));
    const oppStrong = FW.clubStrength ? FW.clubStrength(oppId) : 60;
    const myStrong = FW.clubStrength ? FW.clubStrength(p.clubId) : 60;
    const pct = Math.max(8, Math.min(92, Math.round((myStrong / (myStrong + oppStrong)) * 100)));
    const comp = fx.competition || FW.leagueName(fx.leagueId) || '联赛';
    return '<section class="card next-card" style="' + clubVars(p.clubId) + '">'
      + '<div class="section-head"><div><div class="eyebrow">NEXT MATCH</div><h3>下一场比赛</h3></div><span class="badge">' + (days === 0 ? '今天' : days + ' 天后') + '</span></div>'
      + (function(){const im=FW.matchImportance?FW.matchImportance(fx):null;return im?'<div class="imp-banner tone-'+im.tone+'">'+esc(im.label)+'</div>':''})()
      + '<div class="vs-strip">'
      + '<div class="vs-side" style="' + clubVars(fx.homeClubId) + '"><span class="team-mark">' + esc(FW.clubName(fx.homeClubId)[0] || 'H') + '</span><b>' + esc(FW.clubName(fx.homeClubId)) + '</b><span class="vs-tag">' + (home ? '主场' : '') + '</span></div>'
      + '<div class="vs-mid"><span class="vs-comp">' + esc(comp) + '</span><strong>' + esc(fx.date) + '</strong><span class="subtle">' + (home ? '主场' : '客场') + '</span></div>'
      + '<div class="vs-side away" style="' + clubVars(fx.awayClubId) + '"><span class="team-mark">' + esc(FW.clubName(fx.awayClubId)[0] || 'A') + '</span><b>' + esc(FW.clubName(fx.awayClubId)) + '</b></div>'
      + '</div>'
      + '<div class="vs-power"><span class="subtle">实力对比</span><div class="power-bar"><i style="width:' + pct + '%"></i></div><span class="subtle">' + pct + '% / ' + (100 - pct) + '%</span></div>'
      + '<div class="actions" style="margin-top:12px"><button class="btn primary" data-v="matchday">进入比赛日</button><button class="btn" data-v="matches">比赛中心</button></div>'
      + '</section>';
  }
  // 球场阵型图（SVG，11 个点按阵型排布）
  function pitchSVG(formation, clubId, size) {
    const W = size || 108, H = Math.round(W * 0.62);
    const lines = String(formation || '4-3-3').split('-').map((x) => parseInt(x, 10)).filter((x) => x > 0);
    const shape = lines.length >= 2 ? lines : [4, 3, 3];
    const pts = [[W / 2, H - 7]]; // 门将
    let y = H - 7 - H * 0.16;
    for (const n of shape) {
      for (let i = 0; i < n; i++) {
        const x = ((i + 1) / (n + 1)) * W;
        pts.push([x, y]);
      }
      y -= H * 0.19;
    }
    const dots = pts.map(([x, yy]) => '<circle cx="' + x.toFixed(1) + '" cy="' + Math.max(5, yy).toFixed(1) + '" r="2.6" fill="var(--c1,#2F4858)"/>').join('');
    return '<svg class="pitch-svg" viewBox="0 0 ' + W + ' ' + H + '" style="' + clubVars(clubId) + '" role="img" aria-label="阵型图">'
      + '<rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" rx="6" fill="rgba(120,180,140,.10)" stroke="rgba(20,60,40,.16)"/>'
      + '<line x1="3" y1="' + (H / 2) + '" x2="' + (W - 3) + '" y2="' + (H / 2) + '" stroke="rgba(20,60,40,.14)"/>'
      + '<circle cx="' + (W / 2) + '" cy="' + (H / 2) + '" r="' + (H * 0.13) + '" fill="none" stroke="rgba(20,60,40,.14)"/>'
      + '<rect x="' + (W / 2 - W * 0.17) + '" y="1" width="' + (W * 0.34) + '" height="' + (H * 0.12) + '" fill="none" stroke="rgba(20,60,40,.12)"/>'
      + '<rect x="' + (W / 2 - W * 0.17) + '" y="' + (H - 1 - H * 0.12) + '" width="' + (W * 0.34) + '" height="' + (H * 0.12) + '" fill="none" stroke="rgba(20,60,40,.12)"/>'
      + dots + '</svg>';
  }

  // 进球时间轴（0–90 分钟）
  function goalTimeline(match) {
    const ev = (match.events || []).filter((e) => e.type === 'goal' || e.type === 'goal_own');
    if (!ev.length) return '<div class="timeline-empty"></div>';
    const marks = ev.map((e) => {
      const left = Math.max(0, Math.min(100, (e.minute / 90) * 100));
      return '<i class="tl-mark ' + (e.team === 'home' ? 'home' : 'away') + '" style="left:' + left.toFixed(1) + '%"></i>';
    }).join('');
    return '<div class="timeline-bar"><span class="tl-min">0′</span><div class="tl-track">' + marks + '</div><span class="tl-min">90′</span></div>';
  }
  function matchRow(m){
    const s=m.stats||{},ev=m.events||[],fmt=m.formations||{};
    const home=FW.clubName(m.homeClubId),away=FW.clubName(m.awayClubId);
    const status=(m.status==='played'||m.status==='completed'||!!m.score&&m.status!=='scheduled')?'已结束':'已安排';
    return `<article class="match-card">
      <div class="match-card-top"><span>${m.date}</span>${(function(){var fx=(FW.state.fixtures||[]).find(function(f){return f.id===m.fixtureId});var im=FW.matchImportance?FW.matchImportance(fx||m):null;if(!im&&m.competition)im=FW.matchImportance({competition:m.competition,round:m.round,leagueId:m.leagueId});return im?`<span class="imp-tag tone-${im.tone}">${esc(im.label)}</span>`:''})()}<span class="match-league">${esc(m.competition||FW.leagueName(m.leagueId))}</span><span style="display:flex;gap:8px;align-items:center">${status==='已结束'?`<button class="btn mini-replay" data-laser="${esc(m.id)}" title="射门镭射图">镭射</button><button class="btn mini-replay" data-replay="${esc(m.id)}">回放</button>`:''}<span class="match-status">${status}</span></span></div>
      <div class="match-scoreline">
        <div class="team-block home" style="${clubVars(m.homeClubId)}"><div class="team-mark">${esc(home[0]||'H')}</div><b>${esc(home)}</b></div>
        <div class="score-center"><strong>${m.score.home}-${m.score.away}</strong><span>FT</span></div>
        <div class="team-block away" style="${clubVars(m.awayClubId)}"><div class="team-mark">${esc(away[0]||'A')}</div><b>${esc(away)}</b></div>
      </div>
      ${(window.innerWidth||1200)>=760?`<div class="match-visual"><div class="pitch-box home" style="${clubVars(m.homeClubId)}">${pitchSVG(fmt.home, m.homeClubId, 96)}<span class="pitch-cap">${esc(fmt.home||'—')}</span></div><div class="pitch-vs">${goalTimeline(m)}</div><div class="pitch-box away" style="${clubVars(m.awayClubId)}">${pitchSVG(fmt.away, m.awayClubId, 96)}<span class="pitch-cap">${esc(fmt.away||'—')}</span></div></div>`:``}
      <div class="match-stat-strip">
        <div><small>控球</small><b>${s.possession?.home??'—'}%</b><em>${s.possession?.away??'—'}%</em></div>
        <div><small>射门</small><b>${s.shots?.home??'—'}</b><em>${s.shots?.away??'—'}</em></div>
        <div><small>射正</small><b>${s.shotsOnTarget?.home??'—'}</b><em>${s.shotsOnTarget?.away??'—'}</em></div>
        <div class="xg-stat"><small>xG</small><b>${s.xg?.home??'—'}</b><em>${s.xg?.away??'—'}</em></div>
        <div><small>角球</small><b>${s.corners?.home??'—'}</b><em>${s.corners?.away??'—'}</em></div>
      </div>
      ${ev.length?`<div class="event-line">${ev.slice(0,6).map(e=>`<span>${e.minute}′ ${e.type==='goal'?'⚽':e.type==='yellow'?'🟨':'↔'} ${e.team==='home'?esc(home):esc(away)}${e.scorer?' · '+esc(e.scorer):''}</span>`).join('')}</div>`:''}
      <div class="evaluation"><span>赛后评价</span><b>${esc(m.evaluation?.homeTactic||'—')} · ${esc(m.evaluation?.home||'—')}</b><i>vs</i><b>${esc(m.evaluation?.awayTactic||'—')} · ${esc(m.evaluation?.away||'—')}</b></div>
    </article>`;
  }

    function matchday(){
    const p=FW.state.player;
    if(!p)return `<div class="grid"><section class="card"><div class="empty">先创建你的球员，再进入比赛日。</div></section></div>`;
    const lastId=FW.state.lastPlayerMatchId;
    const last=lastId?FW.state.matches.find(m=>m.id===lastId):null;
    const lastPerf=last?.playerPerformance||null;
    if(last && lastPerf && last.date===FW.state.lastPlayerMatchDate){
      const homeName=FW.clubName(last.homeClubId),awayName=FW.clubName(last.awayClubId),home=last.homeClubId===p.clubId;
      const score=last.score||{home:0,away:0};
      const result=home?(score.home>score.away?'胜':score.home<score.away?'负':'平'):(score.away>score.home?'胜':score.away<score.home?'负':'平');
      const s=last.stats||{}, ev=last.events||[];
      const perfStatus=lastPerf.status==='starter'?'首发出场':lastPerf.status==='substitute'?'替补出场':'未出场';
      const perfMinutes=lastPerf.minutes||0;
      const perfRating=lastPerf.rating??'—';
      const perfGoals=lastPerf.goals||0;
      const perfAssists=lastPerf.assists||0;
      const summaryText=perfMinutes===0?`本场未获得出场时间。继续训练和保持状态，争取下一次机会。`: `${perfStatus} ${perfMinutes} 分钟 · 评分 ${perfRating} · ${perfGoals} 球 ${perfAssists} 助攻`;
      return `<div class="grid"><section class="card matchday-card"><div class="matches-hero"><div><div class="eyebrow">MATCH REPORT · ${esc(last.date)}</div><h1>${esc(last.competition||FW.leagueName(last.leagueId)||'比赛')}</h1><p>赛后表现 · ${result==='胜'?'球队获胜':result==='负'?'球队失利':'双方战平'}</p></div><div class="match-count"><strong>${score.home} - ${score.away}</strong><span>全场</span></div></div><div class="match-scoreline matchday-score"><div class="team-block home" style="${clubVars(last.homeClubId)}"><div class="team-mark">${esc(homeName[0]||'H')}</div><b>${esc(homeName)}</b></div><div class="score-center"><strong>${score.home} - ${score.away}</strong><span>${esc(last.date)}</span></div><div class="team-block away" style="${clubVars(last.awayClubId)}"><div class="team-mark">${esc(awayName[0]||'A')}</div><b>${esc(awayName)}</b></div></div><div class="notice match-summary" style="margin-top:16px"><div class="eyebrow">YOUR PERFORMANCE</div><h3 style="margin:5px 0 7px">本场总结</h3><b>${esc(summaryText)}</b><div class="subtle" style="margin-top:7px">${lastPerf.rating==null?'暂未获得个人评分。':(lastPerf.rating>=8?'表现非常出色，继续保持。':lastPerf.rating>=7?'表现不错，正在建立稳定的比赛影响力。':lastPerf.rating>=6?'完成了本场任务，还有提升空间。':'本场表现低于预期，下一场争取回应。')}</div></div><div class="kpi" style="margin-top:16px"><div class="k"><b>${lastPerf.minutes||0}'</b><span>出场时间</span></div><div class="k"><b>${lastPerf.rating??'—'}</b><span>评分</span></div><div class="k"><b>${lastPerf.goals||0}</b><span>进球</span></div><div class="k"><b>${lastPerf.assists||0}</b><span>助攻</span></div></div><div class="notice" style="margin-top:14px"><b>你的赛后表现</b><div class="subtle" style="margin-top:7px">${lastPerf.status==='starter'?'首发出场':lastPerf.status==='substitute'?'替补出场':'未出场'} · ${lastPerf.minutes||0} 分钟 · 评分 ${lastPerf.rating??'—'} · 球队定位：${roleLabel(lastPerf.role||p.development?.role)}</div><div class="subtle" style="margin-top:5px">教练信任 ${lastPerf.coachTrust??'—'} · 身价 €${Math.round(p.marketValue||0).toLocaleString()}</div></div><div class="notice" style="margin-top:12px"><b>比赛数据</b><div class="xg-grid" style="margin-top:10px"><div><small>控球</small><b>${s.possession?.home??'—'}% — ${s.possession?.away??'—'}%</b></div><div><small>射门</small><b>${s.shots?.home??'—'} — ${s.shots?.away??'—'}</b></div><div><small>射正</small><b>${s.shotsOnTarget?.home??'—'} — ${s.shotsOnTarget?.away??'—'}</b></div><div><small>xG</small><b>${s.xg?.home??'—'} — ${s.xg?.away??'—'}</b></div></div></div>${ev.length?`<div class="notice" style="margin-top:12px"><b>关键事件</b><div class="event-line" style="margin-top:9px">${ev.slice(0,10).map(e=>`<span>${e.minute}′ ${e.type==='goal'?'⚽':e.type==='yellow'?'🟨':'↔'} ${e.team==='home'?esc(homeName):esc(awayName)}${e.scorer?' · '+esc(e.scorer):''}</span>`).join('')}</div></div>`:''}<div class="actions" style="margin-top:18px"><button class="btn primary" data-clear-match-report="1">继续职业生涯</button><button class="btn" data-v="matches">查看比赛中心</button></div></section></div>`;
    }
    const f=FW.nextPlayerFixture();
    if(!f)return `<div class="grid"><section class="card"><div class="eyebrow">MATCH DAY</div><h2>暂无下一场比赛</h2><p class="muted">推进时间后，下一场比赛会自动出现。</p><button class="btn" data-v="matches">查看比赛中心</button></section></div>`;
    const home=f.homeClubId===p.clubId, homeName=FW.clubName(f.homeClubId), awayName=FW.clubName(f.awayClubId);
    const selection=FW.playerMatchSelectionPreview(f)||{status:'unused',minutes:0,confidence:0,trust:45,role:'rotation'};
    const selectionText=selection.status==='injured'?('伤停中 · 还需 '+(selection.daysLeft||'?')+' 天'):selection.status==='starter'?'预计首发':selection.status==='substitute'?'预计替补':'预计无缘名单';
    const selectionTone=selection.status==='injured'?'本场无法出场，推进时间等待恢复':selection.status==='starter'?'首发机会较高':selection.status==='substitute'?'有机会替补出场':'需要继续争取机会';
    const injuryNotice=selection.status==='injured'?`<div class="notice" style="margin-top:14px;border-left:3px solid #e05353"><b>伤停中：${selection.injury||'伤病'}</b><div class="subtle" style="margin-top:5px">还需 ${selection.daysLeft||'?'} 天恢复，本场比赛不会出场。</div></div>`:'';
    // 比赛计划：三组互不重复 —— 战术（球队怎么踢，2D/3D 同一套 5 档）/ 比赛重点（你自己怎么抢镜）/ 换人策略
    // 旧界面的 tactic 是 4 档（平衡/进攻/防守/控球），与 3D 的 5 档不一致；focus 里还有个"反击"与战术重名。
    // 现在 canonical 5 档 + focus 改名"抢攻"，旧存档由引擎侧的别名表兼容。
    const PLAN_ALIAS={进攻:'高压',防守:'低位',均衡:'平衡',快速反击:'反击',稳守反击:'低位'};
    const planRaw=FW.state.playerMatchPlan||{tactic:'平衡',focus:'平衡',subPlan:'正常'};
    const plan=Object.assign({},planRaw,{
      tactic:PLAN_ALIAS[planRaw.tactic]||planRaw.tactic||'平衡',
      focus:planRaw.focus==='反击'?'抢攻':(planRaw.focus||'平衡'),
    });
    const opts=(key,vals)=>vals.map(v=>`<button class="btn ${plan[key]===v?'primary':''}" data-plan-key="${key}" data-plan-value="${v}">${v}</button>`).join('');
    const decision=FW.state.playerMatchDecision;
    const comm=FW.state.player?.development?.coachCommunication||{successStreak:0,failStreak:0,momentum:0};
    const commTrend=comm.successStreak>=2?`连续沟通成功 ${comm.successStreak} 次 · 教练更愿意听取你的想法`:comm.failStreak>=2?`连续沟通未被采纳 ${comm.failStreak} 次 · 暂时维持原计划的可能性更高`:comm.successStreak===1?'最近一次沟通被采纳':comm.failStreak===1?'最近一次沟通未被采纳':'还没有形成沟通趋势';
    const requestBox=decision?.fixtureId===f.id?`<div class="notice" style="margin-top:14px"><b>赛前沟通结果</b><div class="subtle" style="margin-top:6px">${decision.result==='accepted'?'教练接受了你的请求。':'教练没有改变原来的安排。'} · 成功率 ${decision.chance}%</div><div class="subtle" style="margin-top:5px">${commTrend}</div></div>`:(selection.status==='starter'?`<div class="notice" style="margin-top:14px"><b>身体状态不佳？可以沟通</b><div class="subtle" style="margin-top:5px">如果你觉得体能或疲劳不适合首发，可以向教练申请替补或减少出场时间。</div><div class="subtle" style="margin-top:5px">${commTrend}</div><div class="actions" style="margin-top:9px"><button class="btn" data-match-request="request-bench">申请替补</button><button class="btn" data-match-request="request-limited">申请减少出场</button></div></div>`:`<div class="notice" style="margin-top:14px"><b>想争取更多机会？</b><div class="subtle" style="margin-top:5px">你可以根据自己的状态和近期表现，向教练争取首发。成功与否取决于当前情况。</div><div class="subtle" style="margin-top:5px">${commTrend}</div><div class="actions" style="margin-top:9px"><button class="btn primary" data-match-request="seek-starter">向教练争取首发</button></div></div>`);
    return `<div class="grid"><section class="card matchday-card"><div class="matches-hero"><div><div class="eyebrow">MATCH DAY · ${esc(f.date)}</div><h1>${esc(f.competition||FW.leagueName(f.leagueId)||'比赛')}</h1><p>${home?'主场':'客场'} · 赛前准备</p></div><div class="match-count"><strong>VS</strong><span>${home?'主场':'客场'}</span></div></div><div class="match-scoreline matchday-score"><div class="team-block home"><div class="team-mark">${esc(homeName[0]||'H')}</div><b>${esc(homeName)}</b></div><div class="score-center"><strong>—</strong><span>${esc(f.date)}</span></div><div class="team-block away"><div class="team-mark">${esc(awayName[0]||'A')}</div><b>${esc(awayName)}</b></div></div><div class="notice" style="margin-bottom:14px"><div class="eyebrow">YOUR ROLE</div><div style="display:flex;justify-content:space-between;gap:14px;align-items:center;margin-top:6px"><div><h3 style="margin:0 0 5px">${selectionText}</h3><div class="subtle">${selection.status==='unused'?'预计出场 0 分钟':`预计出场约 ${selection.minutes} 分钟`} · ${selectionTone}</div></div><div class="k" style="min-width:92px;text-align:center"><b>${selection.trust}</b><span>教练信任</span></div></div><div class="subtle" style="margin-top:9px">${esc(selection.role==='key player'?'核心球员':selection.role==='regular'?'常规主力':selection.role==='rotation'?'轮换球员':'边缘球员')} · 预计名单把握 ${selection.confidence}%</div></div>${injuryNotice}${requestBox}<div id="fw3d-scout"></div><div id="fw3d-entry"></div><div class="notice"><b>你的比赛计划</b><div class="subtle" style="margin-top:5px">计划只作用于下一场你的比赛，比赛结束后自动清除。三组互不重复：战术决定球队怎么踢，比赛重点决定你自己怎么抢镜，换人策略决定你踢多久。</div><div class="plan-group"><span>战术</span><div class="actions">${opts('tactic',['平衡','控球','反击','高压','低位'])}</div><div class="subtle" style="margin-top:4px">球队打法：控球求稳、反击求快、高压前压、低位收缩（与 3D 比赛里的战术是同一套五档）</div></div><div class="plan-group"><span>比赛重点</span><div class="actions">${opts('focus',['平衡','抢攻','稳健'])}</div><div class="subtle" style="margin-top:4px">你的个人取向：抢攻更可能多进一球，稳健更可能少丢一球</div></div><div class="plan-group"><span>换人策略</span><div class="actions">${opts('subPlan',['正常','60分钟主动调整','领先后保守'])}</div><div class="subtle" style="margin-top:4px">影响你的出场时间：主动调整封顶 60 分钟，领先后保守只在领先时封顶 65 分钟</div></div><div class="actions" style="margin-top:18px"><button class="btn primary" data-adv-until="${esc(f.date)}">推进到比赛日</button><button class="btn" data-v="matches">返回比赛中心</button></div><p class="subtle" style="margin-top:12px">比赛会自动生成首发、替补、关键事件、换人、牌面、进球和你的个人表现；你选择的是比赛思路，而不是手动操控每一分钟。</p></section></div>`;
  }
  function matches(){
    const load=FW.calendarLoad&&FW.state.player&&FW.state.player.clubId?FW.calendarLoad(FW.state.player.clubId):null;
const me=FW.state.player;
    const myClub=me&&me.clubId?FW.state.clubs[me.clubId]:null;
    const myLeagueId=myClub?myClub.leagueId:null;
    const myCountry=myClub?myClub.countryId:(me?me.nationality:null);
    const myLeagueClubIds=myLeagueId?new Set((FW.state.leagues.find(l=>l.id===myLeagueId)||{}).clubIds||[]):new Set();
    const related=(m)=>{
      if(!me||!myClub)return true;
      if(m.national)return m.homeCountry===me.nationality||m.awayCountry===me.nationality;
      if(m.homeClubId===me.clubId||m.awayClubId===me.clubId)return true;
      if(m.leagueId&&m.leagueId===myLeagueId)return true;
      const h=FW.state.clubs[m.homeClubId],a=FW.state.clubs[m.awayClubId];
      if(h&&myLeagueClubIds.has(h.id))return true;
      if(a&&myLeagueClubIds.has(a.id))return true;
      if(h&&h.countryId===myCountry&&m.competitionId&&!m.leagueId)return true;
      if(a&&a.countryId===myCountry&&m.competitionId&&!m.leagueId)return true;
      return false;
    };
    const isMob=(window.innerWidth||1200)<760;
    const matchLimit=window.__matchLimit||(isMob?8:40);
    const relatedAll=[...FW.state.matches].reverse().filter(related);
    const clubRelated=relatedAll.filter(m=>!m.national);
    const natRelated=relatedAll.filter(m=>m.national);
    const natMs=natRelated.slice(0,8);
    const ms=clubRelated.slice(0,matchLimit);
    const picked=ms.concat(natMs);
    window.__matchMoreCount=Math.max(0,clubRelated.length-ms.length);
    const scopeLabel=myClub?('仅显示与你相关：'+(FW.leagueName(myLeagueId)||'')+'、'+(myCountry||'')+' 的杯赛与洲际赛事'):'显示全部比赛';return `<div class="grid"><section class="card matches-page"><div class="matches-hero"><div><div class="eyebrow">MATCH CENTER</div><h1>比赛中心</h1><p>查看最近比赛、阵型、战术与关键数据。<span class="data-footnote"> · ${scopeLabel}</span></p></div><div class="match-count"><strong>${FW.state.matches.length}</strong><span>已完成比赛</span></div></div>${natMs.length?`<section class="card national-card"><div class="section-head"><div><div class="eyebrow">INTERNATIONAL</div><h3>国家队比赛</h3></div></div><div class="nat-match-list">${natMs.map(function(m){var mine=m.homeCountry===me.nationality;var win=mine?(m.score.home>m.score.away):(m.score.away>m.score.home);return '<div class="nat-match'+(win?' win':'')+'"><span class="nm-date">'+esc(m.date)+'</span><span class="nm-comp">'+esc(m.competition||'国际比赛')+'</span><span class="nm-line">'+esc(m.homeCountry)+' <b>'+m.score.home+'-'+m.score.away+'</b> '+esc(m.awayCountry)+'</span></div>'}).join('')}</div></section>`:''}<section class="card schedule-card"><div class="section-head"><div><div class="eyebrow">CALENDAR</div><h3>接下来 3 周</h3></div>${load?`<span class="badge${load.congested?' hot':''}">${load.congested?'赛程密集':'正常'}</span>`:''}</div>${(function(){
        const p0=FW.state.player;if(!p0||!p0.clubId)return '<div class="empty">还没有俱乐部</div>';
        const list=FW.clubSchedule?FW.clubSchedule(p0.clubId,21):[];
        if(!list.length)return '<div class="empty">近期没有比赛</div>';
        return '<div class="sched-list">'+list.map(f=>{
          const comp=f.competition||'联赛';
          const isCup=/杯|冠|联|解放者|南美|世俱/i.test(comp)&&!/联赛/.test(comp);
          const rest=f.rest;
          var fxFull=(FW.state.fixtures||[]).find(function(x){return x.id===f.id});var imp=FW.matchImportance?FW.matchImportance(fxFull||f):null;return '<div class="sched-row'+(f.home?'':' away')+'"><span class="sched-date">'+esc(f.date.slice(5))+'</span>'+(imp?'<span class="imp-tag tone-'+imp.tone+'">'+esc(imp.label)+'</span>':'')+'<span class="sched-comp">'+esc(comp)+'</span><span class="sched-opp">'+(f.home?'vs ':'@ ')+esc(FW.clubName(f.opponentId))+'</span><span class="sched-rest'+(rest<=2?' tight':'')+'">'+(rest===0?'今天':rest+' 天后')+'</span></div>';
        }).join('')+'</div>'
          +'<p class="subtle" style="margin-top:8px">赛程由赛历协调器统一排布：同一支球队一天最多一场，杯赛与洲际赛事会避开联赛日；间隔不超过 2 天时球员体能会受影响。</p>';
      })()}</section>
      ${FW.state.player&&FW.nextPlayerFixture()?`<div class="notice matchday-launch"><div><b>下一场：${esc(FW.clubName(FW.nextPlayerFixture().homeClubId))} vs ${esc(FW.clubName(FW.nextPlayerFixture().awayClubId))}</b><br><span class="subtle">${FW.nextPlayerFixture().date} · 进入比赛日选择战术</span></div><button class="btn primary" data-v="matchday">进入比赛日</button></div>`:''}${ms.length?`<div class="match-list">${ms.map(matchRow).join('')}${window.__matchMoreCount?`<div class="actions" style="margin-top:6px"><button class="btn" data-match-more="1">显示更多比赛（还有 ${window.__matchMoreCount} 场）</button></div>`:''}</div>`:'<div class="empty">还没有比赛。推进时间即可。</div>'}</section></div>`}

  function market(){
    const ps=Object.values(FW.state.players).filter(p=>p.id!=='PUSER');
    const q=(window.__marketQuery||'').trim().toLowerCase(),pos=window.__marketPos||'ALL',maxAge=+(window.__marketAge||0),minCA=+(window.__marketCA||0),league=window.__marketLeague||'ALL';
    const rowsAll=ps.filter(p=>{if(q&&!(`${p.name} ${p.nameEn||''} ${p.nationality} ${p.position} ${posLabel(p.position)}`.toLowerCase().includes(q)))return false;if(pos!=='ALL'&&p.position!==pos)return false;if(maxAge&&p.age>maxAge)return false;if(minCA&&p.ca<minCA)return false;const c=FW.state.clubs[p.clubId];if(league!=='ALL'&&c?.leagueId!==league)return false;return true;}).sort((a,b)=>(b.marketValue||0)-(a.marketValue||0));
    const marketLimit=window.__marketLimit||((window.innerWidth||1200)<760?40:120);
    const allCount=rowsAll.length;
    const rows=rowsAll.slice(0,marketLimit);
    const leagues=FW.state.leagues;
    const p=FW.state.player;
    const opportunities=p?FW.findMarketClubOpportunities():[];
    const active=p?.marketInterests||[];
    const opportunityCards=opportunities.map(o=>{const activeItem=active.find(x=>x.clubId===o.clubId);const status=activeItem?.status;return `<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><b>${esc(o.clubName)}</b><br><span class="subtle">${esc(o.countryName||'')} · ${esc(o.leagueName)} · 第${o.leagueTier}级</span></div><span class="badge">适配 ${o.fit}%</span></div><div class="subtle" style="margin-top:8px">${o.positionNeed?'阵容正需要你的这个位置 · ':''}预计 ${o.role==='regular'?'常规主力':o.role==='rotation'?'轮换':'替补'} · 预估周薪 €${o.estimatedWage.toLocaleString()} · 转会费 €${o.estimatedFee.toLocaleString()}</div>${status==='contacting'?`<div class="subtle" style="margin-top:8px">已主动申请 · 预计 ${esc(activeItem.responseDue)} 收到回应</div>`:status==='responded'?`<div class="notice" style="margin-top:9px"><b>俱乐部愿意进一步了解你</b><br><span class="subtle">合同方案已进入“我的球员 → 职业”。</span></div>`:status==='rejected'?`<div class="subtle" style="margin-top:8px">这次申请暂未通过。</div>`:`<div class="actions" style="margin-top:10px"><button class="btn primary" data-market-request="${o.clubId}">主动申请</button></div>`}</div>`}).join('');
    const cardRows=rows.map(p=>{const c=FW.state.clubs[p.clubId],yrs=FW.contractYearsLeft(p);const retired=p.careerLifecycle?.status==='retired';const free=!retired&&yrs<=0.05;const expiring=!retired&&yrs>0&&yrs<1;const status=retired?'已退役':free?'自由球员':expiring?'合同即将到期':'可转会';return `<button class="notice" data-player-detail="${esc(p.id)}" style="margin-bottom:10px;width:100%;text-align:left;border:0;cursor:pointer"><div style="display:grid;grid-template-columns:1.5fr .9fr .7fr .9fr .9fr;gap:10px;align-items:center"><div><b>${playerNameHTML(p)}</b><br><span class="subtle">${esc(posLabel(p.position))} (${esc(p.position)}) · ${p.age}岁 · ${esc(p.nationality)}</span></div><div style="display:flex;align-items:center;gap:6px"><i class="club-dot" style="${clubVars(p.clubId)}"></i><span class="subtle">${esc(c?.leagueId?FW.leagueName(c.leagueId):'自由球员')}</span></div><div><b>CA ${Math.round(p.ca)}</b><div class="mini-bar"><i style="width:${Math.max(4,Math.min(100,Math.round(p.ca)))}%"></i></div><span class="subtle">PA ${Math.round(p.pa)}</span></div><div><b>€${(p.marketValue||0).toLocaleString()}</b><br><span class="subtle">身价</span></div><div><b>${esc(c?.name||'自由球员')}</b><br><span class="subtle">${c?.leagueId?esc(FW.leagueName(c.leagueId)):'自由球员'}</span></div></div><div class="subtle" style="margin-top:8px">状态：${status} · ${retired?'仅可查看职业履历，不参与转会':free?'免转会费':`${yrs.toFixed(1)}年合同`}</div></button>`}).join('');
    return `<div class="grid">${p?`<section class="card"><div class="section-head"><div><div class="eyebrow">YOUR MARKET</div><h2 style="margin:6px 0">寻找下一站</h2><div class="muted">这里不是单纯看球员，而是帮你寻找真正适合自己的球队。适配度会考虑位置需求、能力、联赛层级和俱乐部环境。</div></div></div>${opportunityCards||'<div class="empty">目前没有合适的主动申请目标。继续比赛、训练和提升定位后再来看看。</div>'}</section>`:''}<section class="card"><div class="section-head"><div><div class="eyebrow">TRANSFER MARKET</div><h2 style="margin:6px 0">球员市场</h2><div class="data-footnote">全部 ${Object.keys(FW.state.players).length} 名球员 · 其中 ${Object.values(FW.state.players).filter(x=>x.isRealPlayer).length} 名真实球员</div><div class="muted">查看世界球员，了解市场身价与合同状态。已退役球员也会保留在搜索结果中，方便查看完整职业履历；退役后不可再次转会。</div></div><span class="badge">${rows.length} / ${allCount} RESULTS</span></div><div class="form market-filters"><input class="input" id="mq" placeholder="搜索球员 / 国籍 / 位置" value="${esc(window.__marketQuery||'')}"><select class="select" id="mp"><option value="ALL">全部位置</option>${FW.POS.map(x=>`<option value="${x}" ${pos===x?'selected':''}>${posLabel(x)} (${x})</option>`).join('')}</select><input class="input" id="ma" type="number" min="0" max="40" placeholder="最大年龄" value="${maxAge||''}"><input class="input" id="mc" type="number" min="0" max="99" placeholder="最低 CA" value="${minCA||''}"><select class="select" id="ml"><option value="ALL">全部联赛</option>${leagues.map(l=>`<option value="${l.id}" ${league===l.id?'selected':''}>${esc(l.name)}</option>`).join('')}</select></div><div class="actions" style="margin-bottom:16px"><button class="btn primary" data-market-search="1">搜索市场</button><button class="btn" data-market-reset="1">重置</button></div>${cardRows||'<div class="empty">没有符合条件的球员。</div>'}${allCount>rows.length?`<div class="actions" style="margin-top:4px"><button class="btn" data-market-more="1">显示更多（还剩 ${allCount-rows.length} 位）</button></div>`:''}</section></div>`;
  }


  function clubDetail(){
    const id=window.__selectedClubId, c=FW.state.clubs?.[id];
    if(!c)return world();
    const league=FW.state.leagues?.find(l=>l.id===c.leagueId);
    const profile=FW.clubProfile?FW.clubProfile(id):null;
    const players=(c.playerIds||[]).map(pid=>FW.state.players?.[pid]).filter(Boolean).filter(p=>p.careerLifecycle?.status!=='retired');
    const rows=players.map(p=>`<div class="notice club-player-row" style="margin-bottom:9px"><button class="club-player-link" data-player-id="${p.id}"><span>${playerNameHTML(p)}</span><span class="subtle">${esc(posLabel(p.position))} · ${p.age}岁 · ${esc(p.nationality)}</span></button><div class="club-player-meta"><span>CA <b>${p.ca}</b></span><span>PA <b>${p.pa}</b></span><span>身价 <b>€${Number(p.marketValue||0).toLocaleString()}</b></span></div></div>`).join('');
    const t=league?FW.table(league.id):[];
    const rank=Math.max(0,t.findIndex(r=>r.clubId===id)+1);
    return `<div class="grid"><section class="card" style="${clubVars(id)}"><div class="club-band"></div><div class="section-head"><div><button class="btn" data-club-back>← 返回世界</button><div class="eyebrow" style="margin-top:14px">CLUB PROFILE</div><h2 style="margin:6px 0">${esc(c.name||'俱乐部')}</h2><div class="muted">${esc(c.countryId||'')} · ${esc(league?.name||'—')}</div></div></div><div class="kpi" style="margin-top:18px"><div class="k"><b>${esc(league?.name||'—')}</b><span>所属联赛</span></div><div class="k"><b>第${rank||'—'}</b><span>当前排名</span></div><div class="k"><b>${league?.tier||'—'}</b><span>联赛级别</span></div><div class="k"><b>${profile?.reputation??c.management?.reputation??'—'}</b><span>俱乐部声望</span></div></div><div class="section-head" style="margin-top:22px"><div><div class="eyebrow">CLUB</div><h3>球队信息</h3></div></div><div class="row"><span>所属国家</span><b>${esc(c.countryId||'—')}</b></div><div class="row"><span>所属联赛</span><b>${esc(league?.name||'—')}</b></div><div class="row"><span>联赛级别</span><b>第${league?.tier||'—'}级</b></div><div class="row"><span>主教练</span><b>${esc(profile?.coach?.name||c.management?.coach?.name||'—')}</b></div><div class="row"><span>战术风格</span><b>${esc(profile?.coach?.style||c.management?.coach?.style||c.tactics?.style||'—')}</b></div><div class="row"><span>主场</span><b>${esc(c.stadium?.name||'—')}</b></div>${c.city?`<div class="row"><span>所在城市</span><b>${esc(c.city)}</b></div>`:''}<div class="row"><span>容量</span><b>${Number(c.stadium?.capacity||0).toLocaleString()}</b></div><div class="row"><span>球衣配色</span><b><i class="kit-swatch" style="background:${(c.colors&&c.colors.primary)||'#2F4858'}"></i><i class="kit-swatch" style="background:${(c.colors&&c.colors.secondary)||'#F4F5F7'}"></i></b></div><div class="section-head" style="margin-top:24px"><div><div class="eyebrow">SQUAD</div><h3>球队阵容 <span class="subtle">${players.length} 人</span></h3></div></div>${rows||'<div class="empty">暂无球员数据。</div>'}</section></div>`;
  }

  function playerDetail(){
    const p=FW.state.players[window.__selectedPlayerId];
    if(!p)return market();
    const lookCard=profileLookCard(p,{club:true});
    const c=FW.state.clubs[p.clubId], league=FW.state.leagues.find(l=>l.id===c?.leagueId);
    const seasons=[...(p.seasonHistory||[])].slice().reverse();
    const currentSeason=p.seasonStats||{};
    const transfers=[...(p.transferHistory||[])].slice().reverse();
    const role=p.development?.role==='key player'?'核心球员':p.development?.role==='regular'?'常规主力':p.development?.role==='rotation'?'轮换球员':'边缘/替补球员';
    const status=p.careerLifecycle?.status==='retired'?'已退役':p.careerLifecycle?.status==='retirement-window'?'退役阶段':'现役';
    const clubDisplay=p.careerLifecycle?.status==='retired'?'已退役':(c?.name||'自由球员'); const leagueDisplay=p.careerLifecycle?.status==='retired'?'职业生涯已结束':(league?.name||'自由球员');
    const statRows=Object.entries(p.stats||{}).map(([k,v])=>`<div class="stat"><div class="stat-top"><span>${statLabels[k]||k}</span><b>${Number(v||0).toFixed(1)}</b></div><div class="meter"><i style="width:${Math.max(0,Math.min(100,Number(v||0)))}%"></i></div></div>`).join('');
    const seasonRows=seasons.map(h=>`<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px"><b>${esc(h.season||'—')}</b><span>${h.appearances||0} 场</span></div><div class="subtle" style="margin-top:6px">首发 ${h.starts||0} · ${h.minutes||0} 分钟 · ${h.goals||0} 球 · ${h.assists||0} 助 · 场均 ${h.appearances?(Number(h.avgRating||0)).toFixed(2):'—'}</div></div>`).join('');
    const transferRows=transfers.map(x=>{const from=x.fromClubId?FW.clubName(x.fromClubId):'自由球员/无俱乐部';const to=x.toClubId?FW.clubName(x.toClubId):'自由身';const type=x.type==='loan'?'租借':x.type==='free-agent'?'自由转会':x.type==='contract-expiry'?'合同到期':x.loan?'租借':'转会';return `<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px"><b>${esc(from)} → ${esc(to)}</b><span>${esc(x.date||'—')}</span></div><div class="subtle" style="margin-top:6px">${type} · ${x.fee?`€${Number(x.fee).toLocaleString()}`:'无转会费'}${x.loan?' · 租借':''}</div></div>`}).join('');
    return `<div class="grid"><section class="card"><div class="actions" style="margin-bottom:12px"><button class="btn" data-back="1">← 返回</button></div><div class="hero"><div class="avatar">${esc((p.nameZh||p.name||'球员')[0])}</div><div><div class="eyebrow">PLAYER PROFILE</div><h2 style="margin:6px 0">${playerNameHTML(p)}</h2><div class="muted">${esc(posLabel(p.position))} · ${p.position} · ${p.age}岁 · ${esc(p.nationality)} · ${p.isRealPlayer?'真人球员':'NPC 球员'}</div></div></div>${p.careerLifecycle?.status==='retired'?`<div class="notice" style="margin-top:14px"><b>已退役</b><div class="subtle" style="margin-top:5px">该球员已结束职业生涯，历史赛季、转会履历和职业数据仍然保留。</div></div>`:''}
      <div class="kpi" style="margin-top:18px"><div class="k"><b>${Number(p.ca||0).toFixed(1)}</b><span>当前能力 CA</span></div><div class="k"><b>${Number(p.pa||0).toFixed(1)}</b><span>潜力 PA</span></div><div class="k"><b>€${Number(p.marketValue||0).toLocaleString()}</b><span>当前身价</span></div><div class="k"><b>${esc(status)}</b><span>职业状态</span></div></div>
      ${lookCard}<div class="row" style="margin-top:10px"><span>外观</span><b><button class="btn" data-goto-appearance="1">自定义外观（发型 / 肤色 / 号码 / 庆祝动作）</button></b></div><div class="section-head" style="margin-top:24px"><div><div class="eyebrow">IDENTITY</div><h3>球员身份</h3></div></div>
      <section class="card"><div class="section-head"><div><div class="eyebrow">ATTRIBUTE RADAR</div><h3>能力放射图</h3></div>${c?`<span class="badge">${esc(c.name)}</span>`:''}</div><div class="radar-wrap" style="${clubVars(p.clubId)}">${radarSVG(p.stats, 250)}</div>${(function(){
      const keys=[['speed','速度'],['shooting','射门'],['passing','传球'],['control','控球'],['defense','防守'],['stamina','体能']];
      const sq=(c?c.playerIds:[]).map(id=>FW.state.players[id]).filter(Boolean).filter(x=>x.id!==p.id);
      const posSq=sq.filter(x=>x.position===p.position);
      const avgOf=(list,k)=>{const v=list.map(x=>x.stats&&x.stats[k]).filter(n=>typeof n==='number');return v.length?v.reduce((a,b)=>a+b,0)/v.length:0};
      return '<div class="radar-bars">'+keys.map(function(g){
        const k=g[0],label=g[1];
        const me=(p.stats&&p.stats[k])||0;
        const team=Math.round(avgOf(sq,k)), pos=Math.round(avgOf(posSq,k));
        const d=Math.round(me-team);
        return '<div class="radar-bar-row"><span class="rbl">'+label+'</span><div class="mini-bar"><i style="width:'+Math.max(4,Math.min(100,me))+'%"></i></div><span class="rbv">'+Math.round(me)+'</span><span class="rbd" style="color:'+(d>=0?'#1a7f47':'#b3261e')+'">'+(d>=0?'+':'')+d+'</span><span class="rbt">队 '+team+' · 同位置 '+pos+'</span></div>';
      }).join('')+'</div>';
    })()}</section>
  <div class="row"><span>姓名</span><b>${playerNameHTML(p)}</b></div><div class="row"><span>英文名</span><b>${esc(p.nameEn||p.name||'—')}</b></div><div class="row"><span>球队定位</span><b>${esc(role)}</b></div>
      <div class="section-head" style="margin-top:24px"><div><div class="eyebrow">CURRENT CONDITION</div><h3>当前状态</h3></div></div>
      <div class="kpi"><div class="k"><b>${Math.round(p.fitness??100)}</b><span>体能</span></div><div class="k"><b>${Math.round(p.morale??75)}</b><span>士气</span></div><div class="k"><b>${Math.round(p.fatigue??0)}</b><span>疲劳</span></div><div class="k"><b>${Math.round(p.development?.coachTrust??45)}</b><span>教练信任</span></div></div>
      <div class="row"><span>本赛季</span><b>${esc(currentSeason.season||FW.state.season)} · ${currentSeason.appearances||0} 次出场 · ${currentSeason.goals||0} 球 · ${currentSeason.assists||0} 助</b></div><div class="row"><span>本赛季分钟</span><b>${currentSeason.minutes||0}</b></div><div class="row"><span>本赛季评分</span><b>${currentSeason.appearances?(Number(currentSeason.avgRating||0)).toFixed(2):'—'}</b></div>
      <div class="section-head" style="margin-top:24px"><div><div class="eyebrow">CONTRACT</div><h3>合同与市场</h3></div></div>
      <div class="row"><span>周薪</span><b>€${Number(p.contract?.weeklyWage||0).toLocaleString()}</b></div><div class="row"><span>合同到期</span><b>${p.contract?.endDate||'—'}</b></div><div class="row"><span>合同剩余</span><b>${FW.contractYearsLeft(p).toFixed(1)} 年</b></div><div class="row"><span>市场身价</span><b>€${Number(p.marketValue||0).toLocaleString()}</b></div>
      <div class="section-head" style="margin-top:24px"><div><div class="eyebrow">SEASON HISTORY</div><h3>完整赛季表现</h3></div></div>${seasonRows||'<div class="empty">暂无完整赛季记录。</div>'}
      <div class="section-head" style="margin-top:24px"><div><div class="eyebrow">TRANSFER HISTORY</div><h3>转会履历</h3></div></div>${transferRows||'<div class="empty">暂无转会记录。</div>'}
    </section></div>`;
  }

  function national(){
    const p=FW.state.player, nts=Object.values(FW.state.nationalTeams||{}), my=p?FW.nationalTeamForPlayer(p):null;
    const ntp=p?.nationalTeam||{}, invited=ntp.invitation?.status==='pending';
    const status=my?(my.squadIds||[]).includes(p.id)?'本期入选国家队':invited?'收到国家队征召邀请':'暂未入选国家队':'创建球员后查看国家队生涯';
    const sel=(p&&FW.nationalSelection)?FW.nationalSelection(p):null;
    const ntCards=nts.map(nt=>{const squad=(nt.squadIds||[]).map(id=>FW.state.players[id]).filter(Boolean);return `<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px"><b><button class="link-btn" data-nation-id="${esc(nt.countryId||'')}">${esc(nt.name)}</button></b><span>${squad.length} 人</span></div><div class="subtle" style="margin-top:6px">主教练 ${esc(nt.coach.name)} · ${esc(nt.coach.style)} · 战绩 ${nt.wins}-${nt.draws}-${nt.losses}</div></div>`}).join('');
    const recent=my?[...(my.fixtures||[])].slice().reverse().slice(0,6):[], ranking=(FW.state.nationalRanking||[]).slice(0,8), tournaments=(FW.state.nationalTournaments||[]).slice().reverse().slice(0,4);
    const rankingRows=ranking.map(x=>`<tr><td class="rank">${x.rank}</td><td class="club-name"><button class="link-btn" data-nation-id="${esc(x.country)}">${esc(x.country)}</button></td><td><b>${x.score}</b></td></tr>`).join('');
    const tournamentRows=tournaments.map(t=>{
      const groups=(t.groups||[]).slice(0,3).map(g=>{
        const rows=(g.table||[]).slice(0,4).map((r,i)=>'<div class="ntg-row'+(i<2?' adv':'')+'"><span>'+(i+1)+'</span><span>'+esc(r.country)+'</span><span>'+r.p+'</span><b>'+r.pts+'</b></div>').join('');
        return '<div class="ntg-box"><div class="ntg-title">'+esc(g.name)+'</div>'+rows+'</div>';
      }).join('');
      const ko=(t.results||[]).filter(r=>r.stage!=='group');
      const final=ko.filter(r=>r.stage==='决赛')[0];
      const koRows=ko.slice(-6).map(r=>'<div class="ntk-row"><span class="ntk-stage">'+esc(r.stage)+'</span><span>'+esc(r.homeCountry)+' '+r.score.home+'-'+r.score.away+' '+esc(r.awayCountry)+'</span><b>'+esc(r.winner)+'</b></div>').join('');
      const champTeam=FW.state.nationalTeams[t.champion];
      return '<div class="notice nt-card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>'+esc(t.name)+'</b><span class="subtle">'+esc(t.startDate)+' · '+t.countryIds.length+' 队</span></div>'
        +'<div class="subtle" style="margin-top:6px">冠军：<b>'+esc(t.champion||'—')+'</b>'+(final?(' · 决赛 '+final.score.home+'-'+final.score.away):'')+(champTeam&&t.champion===(FW.state.player&&FW.state.player.nationality)?' · 你的国家队':'')+'</div>'
        +(groups?'<div class="ntg-grid">'+groups+'</div>':'')
        +(koRows?'<div class="ntk-list">'+koRows+'</div>':'')
        +'</div>';
    }).join('');
    const flagStyle=p&&p.nationality?flagVars(p.nationality):flagVars('中国');
    return `<div class="grid"><section class="card nt-hero" style="${flagStyle}"><div class="section-head"><div><div class="eyebrow">NATIONAL TEAM</div><h2 style="margin:6px 0">国家队</h2><div class="muted">国家队征召由教练决定，但是否接受征召由你决定。</div></div></div>${p&&my?`<div class="kpi"><div class="k"><b>${my.squadIds.includes(p.id)?'入选':'—'}</b><span>当前状态</span></div><div class="k"><b>${p.nationalTeam?.caps||0}</b><span>国家队出场</span></div><div class="k"><b>${p.nationalTeam?.goals||0}</b><span>国家队进球</span></div></div><div class="row"><span>国家队</span><b>${esc(my.name)}</b></div><div class="row"><span>本期征召</span><b>${status}</b></div><div class="row"><span>球员决定</span><b>${ntp.consent==='accepted'?'已同意接受征召':ntp.consent==='declined'?'暂不接受征召':'等待你的决定'}</b></div>${invited?`<div class="actions" style="margin-top:14px"><button class="btn primary" data-national-consent="accepted">接受征召</button><button class="btn" data-national-consent="declined">暂不接受</button></div>`:''}<div class="row"><span>集训状态</span><b>${my.squadIds.includes(p.id)?'集训名单':'等待下一期征召'}</b></div><div class="row"><span>国家队主教练</span><b>${esc(my.coach.name)} · ${esc(my.coach.style)}</b></div>`:'<div class="empty">先创建你的球员，再开始国家队生涯。</div>'}</section><section class="card"><div class="section-head"><div><div class="eyebrow">SQUAD</div><h3>本期名单</h3></div>${my?`<span class="badge">${(my.squadIds||[]).length} 人</span>`:''}</div>${my?(function(){
      const list=(my.squadIds||[]).map(id=>FW.state.players[id]).filter(Boolean);
      if(!list.length)return '<div class="empty">本期暂无征召名单</div>';
      const groups=[['门将',['GK']],['后卫',['CB','LB','RB']],['中场',['CM','AM']],['前锋',['LW','RW','ST']]];
      return groups.map(function(g){
        const label=g[0],poss=g[1];
        const rows=list.filter(function(x){return poss.includes(x.position)}).sort(function(a,b){return (b.ca||0)-(a.ca||0)});
        if(!rows.length)return '';
        return '<div class="squad-group"><div class="squad-label">'+label+'</div>'+rows.map(function(x){
          const mine=x.id===(FW.state.player&&FW.state.player.id);
          return '<div class="squad-row'+(mine?' mine':'')+'"><span class="squad-name">'+esc(x.name)+(mine?' <span class="badge" style="margin-left:6px">你</span>':'')+'</span><span class="squad-club">'+esc(FW.clubName(x.clubId))+'</span><span class="squad-ca">'+Math.round(x.ca)+'</span></div>';
        }).join('')+'</div>';
      }).join('');
    })():'<div class="empty">暂无</div>'}</section>
<section class="card"><div class="section-head"><div><div class="eyebrow">SELECTION</div><h3>我的选情</h3></div>${sel?(sel.inSquad?'<span class="badge" style="background:#eaf7f0;color:#1a7f47">已入选</span>':'<span class="badge">待考察</span>'):''}</div>${sel?`<div class="kpi"><div class="k"><b>第 ${sel.rank}</b><span>国内球员排名</span></div><div class="k"><b>${sel.myScore}</b><span>综合评分</span></div><div class="k"><b>${sel.cutoff}</b><span>入选线</span></div></div><div class="vs-power" style="margin-top:14px"><span class="subtle">离入选线</span><div class="power-bar"><i style="width:${Math.max(4,Math.min(100,Math.round(sel.cutoff?sel.myScore/sel.cutoff*100:0)))}%"></i></div><span class="subtle">${sel.myScore>=sel.cutoff?'已达标':'差 '+(Math.round((sel.cutoff-sel.myScore)*10)/10)}</span></div><div class="row" style="margin-top:10px"><span>同位置竞争</span><b>第 ${sel.posRank} / ${sel.posCount}</b></div><div class="row"><span>评估意见</span><b style="font-weight:500;max-width:60%;text-align:right">${esc(sel.reason)}</b></div>${sel.captain?`<div class="row"><span>本期队长</span><b>${esc(sel.captain.name)}</b></div>`:''}${sel.nextMatchDate?`<div class="row"><span>下一场国家队比赛</span><b>${esc(sel.nextMatchDate)}</b></div>`:''}`:'<div class="empty">先创建球员后查看国家队选情</div>'}</section>
  <section class="card"><div class="section-head"><div><div class="eyebrow">CAPS</div><h3>国家队履历</h3></div>${p&&p.nationalTeam?`<span class="badge">${p.nationalTeam.caps||0} 场 · ${p.nationalTeam.goals||0} 球</span>`:''}</div>${(function(){
    const hist=(p&&p.nationalTeam&&p.nationalTeam.history)||[];
    if(!hist.length)return '<div class="empty">尚未代表国家队出场</div>';
    return hist.slice().reverse().slice(0,8).map(function(h){
      return '<div class="caps-row"><span class="caps-date">'+esc(h.date)+'</span><span class="caps-opp">vs '+esc(h.opponent||'')+'</span><span class="caps-tag">'+(h.started?'首发':'替补')+' '+h.minutes+'′</span><span class="caps-g">'+(h.goals?('⚽'+h.goals):'')+(h.assists?(' 🅰'+h.assists):'')+'</span></div>';
    }).join('');
  })()}</section>
<section class="card half"><div class="section-head"><div><div class="eyebrow">INTERNATIONAL WINDOW</div><h3>最近国际比赛</h3></div></div>${recent.length?recent.map(m=>`<div class="notice" style="margin-bottom:10px"><b>${esc(m.date)}</b><br><span class="subtle">${esc(m.countryId)} ${m.homeCountry===m.countryId?m.score.home:m.score.away} - ${m.homeCountry===m.countryId?m.score.away:m.score.home} ${esc(m.opponent)}</span></div>`).join(''):'<div class="empty">还没有国家队比赛。</div>'}</section><section class="card half"><div class="section-head"><div><div class="eyebrow">WORLD RANKING</div><h3>国家队排名</h3></div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>国家</th><th>积分</th></tr></thead><tbody>${rankingRows||'<tr><td colspan="3">暂无排名</td></tr>'}</tbody></table></div></section><section class="card half"><div class="section-head"><div><div class="eyebrow">MAJOR TOURNAMENTS</div><h3>世界杯 / 欧洲杯</h3></div></div>${tournamentRows||'<div class="empty">重大赛事将在对应年份的夏季举行。</div>'}</section><section class="card"><div class="section-head"><div><div class="eyebrow">NATIONAL ECOSYSTEM</div><h3>国家队体系</h3></div></div>${ntCards}</section></div>`;
  }
    function world(){const isMobile=(window.innerWidth||1200)<760;
    const ASIA=new Set(['中国','日本','韩国','沙特阿拉伯']);
    const allLeagues=(Array.isArray(FW.state.leagues)?FW.state.leagues:[]).filter(l=>l.simulated!==false);
    const comps=Array.isArray(FW.state.internationalCompetitions)?FW.state.internationalCompetitions:[];
    const clubs=FW.state.clubs||{};
    const countries=[];
    allLeagues.forEach(l=>{if(!countries.includes(l.countryId))countries.push(l.countryId)});
    const myCountry=(FW.state.player&&FW.state.player.clubId&&FW.state.clubs[FW.state.player.clubId])?FW.state.clubs[FW.state.player.clubId].countryId:null;
    const active=window.__worldCountry||(isMobile&&myCountry?myCountry:'全部');
    const worldLimit=window.__worldLimit||(isMobile?2:6);
    const shownAll=active==='全部'?allLeagues:allLeagues.filter(l=>l.countryId===active);
    const shown=shownAll.slice(0,worldLimit);
    const worldMore=shownAll.length>shown.length;

    // 一次扫描算完所有联赛积分，避免逐个联赛重复遍历 fixtures
    const rowsByLeague={};
    allLeagues.forEach(l=>{const rows={};(l.clubIds||[]).forEach(id=>{rows[id]={clubId:id,p:0,w:0,d:0,l:0,gf:0,ga:0,pts:0}});rowsByLeague[l.id]=rows});
    const fixtures=Array.isArray(FW.state.fixtures)?FW.state.fixtures:[];
    for(let i=0;i<fixtures.length;i++){
      const f=fixtures[i];
      if(f.status!=='completed'||!f.leagueId||!f.result)continue;
      const rows=rowsByLeague[f.leagueId];if(!rows)continue;
      const h=rows[f.homeClubId],a=rows[f.awayClubId];if(!h||!a)continue;
      const hg=Number(f.result.home)||0,ag=Number(f.result.away)||0;
      h.p++;a.p++;h.gf+=hg;h.ga+=ag;a.gf+=ag;a.ga+=hg;
      if(hg>ag){h.w++;a.l++;h.pts+=3}else if(hg<ag){a.w++;h.l++;a.pts+=3}else{h.d++;a.d++;h.pts++;a.pts++;}
    }
    const tableFor=l=>Object.values(rowsByLeague[l.id]||{}).sort((x,y)=>y.pts-x.pts||(y.gf-y.ga)-(x.gf-x.ga)||y.gf-x.gf);

    const chip=label=>`<button class="${active===label?'active':''}" data-world-country="${esc(label)}">${esc(label)}</button>`;
    const countryChip=(x)=>'<button class="chip-btn'+(active===x?' on':'')+'" data-country="'+esc(x)+'">'+esc(x)+'</button>';
    const chips='<div class="tabs" style="flex-wrap:wrap;gap:6px;margin:6px 0 4px">'+['全部','洲际',...countries].map(countryChip).join('')+'</div>';
    const isContinental=active==='洲际';
    const compFilter=window.__compFilter||'ALL';
    const compChips=isContinental?('<div class="tabs comp-filter-row" style="flex-wrap:wrap;gap:6px;margin:6px 0 4px">'+[['ALL','全部赛事'],['UCL','欧冠'],['UEL','欧联'],['UECL','欧协联'],['ACLE','亚冠'],['ACL2','亚冠2'],['LIB','解放者杯'],['SUD','南美杯'],['CWC','世俱杯'],['WORLD','世界杯'],['EURO','欧洲杯'],['ASIAN','亚洲杯'],['AFRICA','非洲杯'],['COPA','美洲杯']].map(function(e){return '<button class="chip-btn'+(compFilter===e[0]?' on':'')+'" data-comp-filter="'+e[0]+'">'+e[1]+'</button>'}).join('')+'</div>'):'';

    const compsShown=(window.__compFilter&&window.__compFilter!=='ALL')?comps.filter(c=>c.id===window.__compFilter):comps;
    const intlCards=compsShown.map(c=>{
      const t=Array.isArray(c.table)?c.table:[];
      const ids=Array.isArray(c.clubIds)?c.clubIds:[];
      const teams=c.teams||ids.length;
      const perTeam=c.matchesPerTeam||8;
      const knockout=!!(c.bracket&&c.bracket.length);
      const champion=c.champion?FW.clubName(c.champion):'';
      const isBig=teams>=24;
      const fmt=isBig
        ? (teams+' 队 · 联赛阶段每队 '+perTeam+' 场 · 前 8 直接进 1/8，9–24 名打淘汰赛附加赛，25 名之后出局')
        : (teams+' 队 · 联赛阶段每队 '+perTeam+' 场 · 前 8 进入淘汰赛');
      const rows=t.slice(0,8).map((r,i)=>'<tr><td class="rank">'+(i+1)+'</td><td class="club-name"><button class="table-club-link" data-world-club-id="'+r.clubId+'">'+esc(FW.clubName(r.clubId))+'</button></td><td>'+(r.p||0)+'</td><td><b>'+(r.pts||0)+'</b></td><td>'+((r.gf||0)+'/'+(r.ga||0))+'</td></tr>').join('');
      const byCountry={};
      (c.entries||[]).forEach(e=>{byCountry[e.leagueName||e.country]=(byCountry[e.leagueName||e.country]||0)+1});
      const entries=Object.keys(byCountry).length?'<div class="intl-sources"><span class="ie-title-inline">参赛联赛</span>'+Object.entries(byCountry).map(([k,v])=>'<span class="src-chip">'+esc(k)+' <b>'+v+'</b></span>').join('')+'</div>':'';
      const bracket=knockout?c.bracket.map(r=>{
        const ties=r.ties.map(x=>{
          const an=FW.clubName(x.a),bn=FW.clubName(x.b),wn=FW.clubName(x.winner);
          return '<div class="tie-row"><span class="tie-team'+(x.winner===x.a?' win':'')+'">'+esc(an)+'</span><span class="tie-score">'+x.agg.a+' - '+x.agg.b+'</span><span class="tie-team'+(x.winner===x.b?' win':'')+'">'+esc(bn)+'</span><span class="tie-win">'+esc(wn)+'</span></div>';
        }).join('');
        return '<div class="bracket-round"><div class="br-title">'+esc(r.name)+'</div>'+ties+'</div>';
      }).join(''):'';
      return '<section class="card half intl-card" style="'+compVars(c.id)+'"><div class="section-head"><div><div class="eyebrow">'+esc(c.short||'国际赛事')+'</div><h3><button class="link-btn" data-comp-id="'+esc(c.id)+'">'+esc(c.name||'国际赛事')+'</button></h3></div><span class="badge">'+teams+' 队</span></div>'
        +'<div class="notice"><b class="intl-fmt">'+esc(fmt)+'</b>'+(champion?'<div class="subtle" style="margin-top:6px">本赛季冠军：<b>'+esc(champion)+'</b></div>':'')+'</div>'
        +'<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>#</th><th>俱乐部</th><th>场</th><th>积分</th><th>进/失</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
        +(entries?'<div class="intl-entries"><div class="ie-title">参赛球队与来源</div>'+entries+'</div>':'')
        +(bracket?'<div class="intl-bracket"><div class="ie-title">淘汰赛</div>'+bracket+'</div>':'')
        +'</section>';
    }).join('');

    const EUROPE=new Set(['英格兰','西班牙','法国','意大利','德国','荷兰','葡萄牙']);
    const leagueCards=shown.map(l=>{
      const t=tableFor(l);
      const clubCount=(Array.isArray(l.clubIds)?l.clubIds:[]).length;
      const asia=ASIA.has(l.countryId);
      const europe=EUROPE.has(l.countryId);
      const topLabel=asia?'亚冠':'欧冠';
      const legend=l.tier===1
        ?(europe||asia
          ? `<div class="league-legend"><span class="legend-chip ucl">${topLabel}</span>${asia?'':'<span class="legend-chip uel">欧联</span><span class="legend-chip uecl">欧协联</span>'}<span class="legend-chip relegation">降级区</span></div>`
          : `<div class="league-legend"><span class="legend-chip relegation">降级区</span></div>`)
        :`<div class="league-legend"><span class="legend-chip promotion">升级区</span>${l.tier<3?'<span class="legend-chip relegation">降级区</span>':''}</div>`;
      const rows=t.map((r,i)=>{
        const relegation=i>=Math.max(0,clubCount-2)&&l.tier<3;
        const promotion=l.tier>1&&i<2;
        let cls='';let label='';
        if(l.tier===1){
          if(asia&&i<3){cls='ucl';label=topLabel}
          else if(europe&&i<4){cls='ucl';label=topLabel}
          else if(europe&&i<6){cls='uel';label='欧联'}
          else if(europe&&i===6){cls='uecl';label='欧协联'}
          else if(relegation){cls='relegation';label='降级区'}
        }else if(relegation){cls='relegation';label='降级区'}
        else if(promotion){cls='promotion';label='升级区'}
        const mine=FW.state.player&&r.clubId===FW.state.player.clubId;
        return `<tr class="league-row ${cls}${mine?' is-me':''}" style="${clubVars(r.clubId)}"><td class="rank">${i+1}</td><td class="club-name"><button class="table-club-link" data-world-club-id="${r.clubId}">${clubDot(r.clubId)}${esc(FW.clubName(r.clubId))}</button></td><td>${r.p}</td><td><b>${r.pts}</b></td><td>${label?`<span class="table-status ${cls}">${label}</span>`:'<span class="subtle">—</span>'}</td></tr>`;
      }).join('');
      return `<section class="card half"><div class="section-head"><div><div class="eyebrow">${esc(l.code||'LEAGUE')} · ${esc(l.countryId||'')}</div><h3>${esc(l.name||'联赛')}</h3></div><span class="badge">${clubCount} 队 · ${l.split?((l.splitRound||33)+5):((clubCount-1)*2)} 轮</span></div>${legend}<div class="table-wrap"><table><thead><tr><th>#</th><th>俱乐部</th><th>场</th><th>积分</th><th>资格</th></tr></thead><tbody>${rows}</tbody>${(function(){
      const L=FW.leagueLeaders?FW.leagueLeaders(l.id,5):{scorers:[],assists:[]};
      if(!L.scorers.length&&!L.assists.length)return '';
      const row=(x,i,val)=>'<div class="lead-row'+(x&&x.you?' is-you':'')+'"><span class="lead-rank">'+(i+1)+'</span><span class="lead-name">'+esc(x.name)+(x&&x.you?' <b class="you-tag">你</b>':'')+'</span><span class="lead-club">'+esc(FW.clubName(x.clubId))+'</span><b>'+val+'</b></div>';
      return '<div class="lead-grid">'
        +'<div class="lead-box"><div class="lead-title">射手榜</div>'+(L.scorers.map((x,i)=>row(x,i,x.goals)).join('')||'<div class="subtle">暂无</div>')+'</div>'
        +'<div class="lead-box"><div class="lead-title">助攻榜</div>'+(L.assists.map((x,i)=>row(x,i,x.assists)).join('')||'<div class="subtle">暂无</div>')+'</div>'
        +'</div>';
    })()}</table></div></section>`;
    }).join('');

    const myCups=(FW.state.cups||[]).filter(c=>!isContinental&&active!=='全部'&&c.countryId===active);
    const cupCards=myCups.map(c=>{
      const champ=c.champion?FW.clubName(c.champion):'进行中';
      return '<section class="card half cup-card"><div class="section-head"><div><div class="eyebrow">DOMESTIC CUP</div><h3><button class="link-btn" data-cup-id="'+esc(c.id)+'">'+esc(c.name)+'</button></h3></div><span class="badge">'+((c.participants||[]).length)+' 队</span></div>'
        +'<div class="notice"><b>'+esc(c.format||'单场淘汰')+'</b><div class="subtle" style="margin-top:6px">参赛：'+((c.participants||[]).length)+' 队 · '+(c.slotTo?'冠军获得 '+({UEL:'欧联',UECL:'欧协联',ACLE:'亚冠',ACL2:'亚冠二级',LIB:'解放者杯'}[c.slotTo]||c.slotTo)+' 名额':'无洲际名额')+'</div></div>'
        +'<div class="row" style="margin-top:10px"><span>当前轮次</span><b>'+esc(((c.rounds||[]).slice(-1)[0]||{}).name||'待定')+'</b></div>'
        +'<div class="row"><span>冠军</span><b>'+esc(champ)+'</b></div></section>';
    }).join('');
    const kpi=(n,label)=>`<div class="k"><b>${n}</b><span>${label}</span></div>`;
    const transfers=(FW.state.transferHistory||[]).slice().reverse().slice(0,6).map(x=>{
      const pl=FW.state.players[x.playerId];
      const fee=Number(x.fee||0);
      const kind=x.type==='free-agent'?'自由转会':x.type==='loan'?'租借':'转会';
      const kindCls=x.type==='loan'?'loan':x.type==='free-agent'?'free':'buy';
      const bars=Math.max(0,Math.min(10,Math.round(fee/3000000)));
      const feeBar='<span class="fee-bar">'+Array.from({length:10},(_,i)=>'<i class="'+(i<bars?'on':'')+'"></i>').join('')+'</span>';
      const route=(x.fromClubId&&x.toClubId)
        ? '<span class="xf-club" style="'+clubVars(x.fromClubId)+'">'+clubDot(x.fromClubId)+esc(FW.clubName(x.fromClubId))+'</span><span class="xf-arrow">→</span><span class="xf-club" style="'+clubVars(x.toClubId)+'">'+clubDot(x.toClubId)+esc(FW.clubName(x.toClubId))+'</span>'
        : '<span class="xf-club" style="'+(x.toClubId?clubVars(x.toClubId):'')+'">'+(x.toClubId?clubDot(x.toClubId)+esc(FW.clubName(x.toClubId)):'无俱乐部')+'</span>';
      return '<div class="notice transfer-item" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>'+playerNameHTML(pl||{name:'球员'})+'</b><span class="xf-kind '+kindCls+'">'+kind+'</span></div><div class="xf-route">'+route+'</div><div class="xf-foot"><span class="subtle">'+esc(x.date)+'</span>'+(fee>0?('<span class="xf-fee">€'+fee.toLocaleString()+'</span>'+feeBar):'<span class="subtle">无转会费</span>')+'</div></div>';
    }).join('')||'<div class="empty">转会窗口开启后会出现世界转会动态。</div>';
    const EV_ICON={transfer:'🔁',injury:'🩹',cup:'🏆',award:'🏅',achievement:'✨',objective:'🎯',retirement:'🎬',youth:'🌱','coaching-change':'🧠','club-crisis':'⚠️','major-tournament':'🌍',promotion:'📈',career:'📰',player:'👤',club:'🏟️'};
    const events=(FW.state.worldEvents||[]).slice().reverse().slice(0,10).map(e=>`<div class="notice ev-item" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b><span class="ev-icon">${EV_ICON[e.type]||'•'}</span>${esc(e.title)}</b><span class="subtle">${esc(e.date)}</span></div><div class="subtle" style="margin-top:6px">${esc(e.detail)}</div></div>`).join('')||'<div class="empty">世界正在平静运行。推进时间后会出现动态事件。</div>';
    const countriesHtml=Object.values(FW.state.countries||{}).map(c=>`<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px"><b>${esc(c.name)}</b><span>声望 ${c.federation?.reputation??'—'}</span></div><div class="subtle" style="margin-top:6px">${esc(c.federation?.name||'足协')} · ${(c.leagueIds||[]).length} 个联赛 · ${(c.clubIds||[]).length} 家俱乐部 · ${esc(c.leagueFocus||'')}</div></div>`).join('');

    const lastSeason=(FW.state.seasons||[]).slice(-1)[0];
    const seasonAwards=(lastSeason&&lastSeason.awards)||[];
    const worldBest=seasonAwards.find(a=>a.type==='世界足球先生');
    const awardsByLeague={};
    seasonAwards.forEach(a=>{if(a.leagueId==='WORLD')return;(awardsByLeague[a.leagueName]=awardsByLeague[a.leagueName]||[]).push(a)});
    const awardRows=Object.keys(awardsByLeague).map(name=>{
      const list=awardsByLeague[name];
      const pick=(t)=>list.find(a=>a.type===t);
      const chips=['金靴','助攻王','赛季MVP','最佳新人','最佳门将'].map(t=>{
        const a=pick(t);
        return a?`<span class="badge" style="margin:2px 4px 2px 0">${esc(t)} · ${esc(a.playerName)} ${a.value==null?'':esc(String(a.value))+(a.unit||'')}</span>`:'';
      }).join('');
      return `<div class="notice" style="margin-bottom:8px"><b>${esc(name)}</b><div style="margin-top:6px">${chips||'<span class="subtle">暂无</span>'}</div></div>`;
    }).join('');
    const cupRows=((lastSeason&&lastSeason.cups)||[]).map(c=>{
      const champ=FW.clubName(c.champion);
      const runner=FW.clubName(c.runnerUp);
      let score='';
      let pens='';
      if(c.score){
        const cs=c.championIsHome?c.score.home:c.score.away;
        const rs=c.championIsHome?c.score.away:c.score.home;
        score=` ${cs}-${rs}`;
        if(c.pens){const cp=c.championIsHome?c.pens.home:c.pens.away;const rp=c.championIsHome?c.pens.away:c.pens.home;pens=`（点球 ${cp}-${rp}）`}
      }
      return `<div class="notice" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:12px"><b>${esc(c.name)}</b><span>${esc(c.short||'')}</span></div><div class="subtle" style="margin-top:5px">冠军：${esc(champ)}${score} 亚军：${esc(runner)}${pens}</div></div>`;
    }).join('');
    const honoursHtml=(worldBest||awardRows||cupRows)?`
      <section class="card"><div class="section-head"><div><div class="eyebrow">HONOURS · ${esc(lastSeason?lastSeason.season:'')}</div><h3>上赛季奖项与杯赛冠军</h3></div>${worldBest?`<span class="badge">世界足球先生 · ${esc(worldBest.playerName)}</span>`:''}</div>
        ${worldBest?`<div class="notice" style="margin-bottom:12px"><b>世界足球先生：${esc(worldBest.playerName)}</b><div class="subtle" style="margin-top:4px">${esc(worldBest.clubName)} · 平均评分 ${worldBest.value}</div></div>`:''}
        ${awardRows||'<div class="empty">赛季结束后会评选金靴、助攻王、MVP、最佳新人与最佳门将。</div>'}
        <div class="section-head" style="margin-top:18px"><div><div class="eyebrow">DOMESTIC CUPS</div><h3>国内杯赛</h3></div></div>
        ${cupRows||'<div class="empty">杯赛会在赛季中逐轮进行。</div>'}
      </section>`:'';

const ntCompFilter=window.__compFilter||'ALL';
    const ntList=(FW.nationalTournamentList?FW.nationalTournamentList():[]).filter(t=>ntCompFilter==='ALL'||ntCompFilter===t.type);
    const ntCards=(isContinental?ntList:[]).map(t=>'<section class="card half nt-comp-card" style="'+flagVars((FW.state.player&&FW.state.player.nationality)||'中国')+'"><div class="section-head"><div><div class="eyebrow">NATIONAL COMPETITION</div><h3><button class="link-btn" data-nt-id="'+esc(t.id)+'">'+esc(t.name)+'</button></h3></div><span class="badge">'+t.teams+' 队</span></div>'
      +'<div class="notice"><b>'+esc(t.season)+' · '+esc(t.startDate)+'</b><div class="subtle" style="margin-top:6px">'+t.groups+' 个小组 · '+t.matches+' 场 · 冠军 '+(t.champion?esc(t.champion):'未产生')+'</div></div></section>').join('');
    return `<div class="grid">
      <section class="card"><div class="section-head"><div><div class="eyebrow">CLUB WORLD</div><h2 style="margin:6px 0">世界俱乐部体系</h2><div class="muted">欧洲五大联赛 + 荷甲、葡超，南美巴甲，运行。<span class="data-footnote">· ${FW.state.leagues.length} 个联赛 · ${Object.keys(FW.state.clubs).length} 家俱乐部 · ${Object.keys(FW.state.players).length} 名球员</span></div></div></div>
        <div class="notice"><b>足球生态数据层</b><br><span class="subtle">国家 → 足协 → 联赛体系 → 俱乐部 → 青训，每一层都有独立身份标识并保持所属关系。</span>
          <div class="kpi" style="margin-top:14px">${kpi(countries.length,'国家/地区')}${kpi(Object.keys(clubs).length,'俱乐部')}${kpi(allLeagues.length,'联赛')}${kpi(Object.keys(FW.state.players||{}).length,'球员')}</div>
        </div>
        <div class="section-head" style="margin-top:18px"><div><div class="eyebrow">FILTER</div><h3>按国家/地区查看</h3></div></div>
        ${chips}
      </section>
      ${isContinental?`<div class="section-head" style="margin-top:8px;grid-column:span 12"><div><div class="eyebrow">CONTINENTAL</div><h3>洲际俱乐部赛事</h3></div></div>${compChips}`:''}
${isContinental?(intlCards||'<div class="empty">洲际赛事将在赛季开始后生成。</div>'):''}${isContinental?(ntCards||''):''}
      ${honoursHtml}
      ${(!isContinental&&cupCards)?`<div class="section-head" style="margin-top:8px;grid-column:span 12"><div><div class="eyebrow">CUPS</div><h3>国内杯赛</h3></div></div>${cupCards}`:''}${isContinental?'':`<div class="section-head" style="margin-top:8px;grid-column:span 12"><div><div class="eyebrow">LEAGUES</div><h3>联赛积分榜 · ${esc(active)}</h3></div></div>`}
      ${isContinental?'':(leagueCards||'<div class="empty">该国家暂无联赛。</div>')}${(!isContinental&&worldMore)?`<div class="actions" style="grid-column:span 12"><button class="btn" data-world-more="1">显示更多联赛（还有 ${shownAll.length-shown.length} 个）</button></div>`:''}
            <section class="card"><div class="section-head"><div><div class="eyebrow">TRANSFER MARKET</div><h3>世界转会市场</h3></div></div>
        <div class="notice"><div class="kpi">${kpi(FW.state.transferHistory?.length||0,'近期转会')}${kpi(FW.state.freeAgents?.length||0,'自由球员')}${kpi(FW.state.loans?.length||0,'租借中')}</div>
        <div class="subtle" style="margin-top:10px">转会窗口：1 月、7—8 月。AI 俱乐部会按能力、年龄、阵容需求和预算进行引援、出售、签约与租借。</div></div>
        ${transfers}
      </section>
      <section class="card"><div class="section-head"><div><div class="eyebrow">WORLD EVENTS</div><h3>世界动态</h3></div></div>
        ${events}
      </section>
      <section class="card"><div class="section-head"><div><div class="eyebrow">FOOTBALL ECOSYSTEM</div><h3>国家与足协</h3></div></div>
        ${countriesHtml}
      </section>
    </div>`;
  }

  function agent(){const p=FW.state.player;if(!p)return `<div class="grid"><section class="card"><div class="empty">请先创建球员。</div></section></div>`;const agent=FW.agentSummary?FW.agentSummary(p):null;const diag=FW.transferDiagnosis?FW.transferDiagnosis(p):null;const ev=p.careerEvent;const plan=p.agentPlan||{};const interests=p.agentInterests||[];const follow=p.agentFollowUp;const events=(FW.state.worldEvents||[]).filter(e=>e.type==='career'||e.scope==='career'||e.kind==='career').slice().reverse().slice(0,12);return `<div class="grid"><section class="card agent-card"><div class="section-head"><div><div class="eyebrow">YOUR AGENT</div><h3>${agent?esc(agent.name):'尚未签约经纪人'}</h3></div>${agent?`<span class="badge">${'★'.repeat(agent.quality)}${'☆'.repeat(5-agent.quality)}</span>`:''}</div>${agent?`<div class="kpi"><div class="k"><b>${agent.quality}</b><span>影响力等级</span></div><div class="k"><b>${Math.round(agent.commission*100)}%</b><span>佣金比例</span></div><div class="k"><b>${agent.trust}</b><span>与你的关系</span></div></div><div class="vs-power" style="margin-top:12px"><span class="subtle">本月委托</span><div class="power-bar"><i style="width:${agent.actionsLeft>0?100:0}%"></i></div><span class="subtle">${agent.actionsLeft>0?'还剩 1 次':'本月已用完'}</span></div><div class="agent-actions"><button class="btn${agent.actionsLeft>0?'':' disabled'}" data-agent-act="wage"${agent.actionsLeft>0?'':' disabled'}>谈加薪</button><button class="btn${agent.actionsLeft>0?'':' disabled'}" data-agent-act="club"${agent.actionsLeft>0?'':' disabled'}>找下家</button><button class="btn${agent.actionsLeft>0?'':' disabled'}" data-agent-act="loan"${agent.actionsLeft>0?'':' disabled'}>申请租借</button><button class="btn${agent.actionsLeft>0?'':' disabled'}" data-agent-act="talk"${agent.actionsLeft>0?'':' disabled'}>争取出场</button></div><div class="subtle" style="margin-top:8px">人脉：${agent.network.map(esc).join(' · ')} · 每次委托消耗本月 1 次机会；成功率取决于影响力、你们的关系和近期评分。</div>${(agent.history&&agent.history.length)?`<div class="agent-log">${agent.history.map(h=>`<div class="agent-log-row"><span class="subtle">${esc(h.date)}</span><span>${esc(h.text)}</span></div>`).join('')}</div>`:''}`:'<div class="empty">没有经纪人意味着你只能自己找机会。先通过经纪人页签联系一位。</div>'}</section>
  <section class="card"><div class="section-head"><div><section class="card transfer-diag"><div class="section-head"><div><div class="eyebrow">TRANSFER READINESS</div><h3>转会可行性</h3></div>${diag?`<span class="badge">${esc(diag.verdict)}</span>`:''}</div>${diag?`<div class="vs-power" style="margin-top:6px"><span class="subtle">就绪度</span><div class="power-bar"><i style="width:${diag.readiness}%"></i></div><span class="subtle">${diag.readiness}%</span></div>${diag.blockers.length?`<div class="diag-block"><div class="diag-title">为什么现在转不了</div>${diag.blockers.map(b=>`<div class="diag-row bad"><span class="diag-mark">✕</span><div><b>${esc(b.label)}</b><div class="subtle">${esc(b.detail)}</div></div></div>`).join('')}</div>`:`<div class="diag-block"><div class="diag-title">可以推进</div><div class="diag-row good"><span class="diag-mark">✓</span><div><b>条件已齐备</b><div class="subtle">打开下方已回应的俱乐部，选择一支推进合同。</div></div></div></div>`}${diag.steps.length?`<div class="diag-block"><div class="diag-title">当前状态</div>${diag.steps.map(s=>`<div class="diag-row ok"><span class="diag-mark">·</span><div>${esc(s)}</div></div>`).join('')}</div>`:''}<div class="diag-block"><div class="diag-title">怎样才能转会</div>${diag.tips.map((t,i)=>`<div class="diag-row tip"><span class="diag-mark">${i+1}</span><div>${esc(t)}</div></div>`).join('')}</div>`:'<div class="empty">创建球员后查看转会条件</div>'}</section>
  <div class="eyebrow">AGENT</div><h2 style="margin:6px 0">经纪人</h2><div class="muted">经纪人会根据你的能力、定位、出场时间和当前联赛级别寻找合理机会。</div></div></div>${ev?`<div class="notice" style="margin-bottom:12px"><div class="eyebrow">待处理</div><h3 style="margin:5px 0 7px">${esc(ev.title)}</h3><div class="subtle">${esc(ev.detail)}</div><div class="actions" style="margin-top:12px">${ev.choices.map(c=>`<button class="btn primary" data-career-choice="${c.id}">${esc(c.label)}</button>`).join('')}</div></div>`:`<div class="notice"><b>目前没有待处理消息</b><br><span class="subtle">推进时间后，经纪人会根据你的表现、出场时间和合同情况联系你。</span></div>`}${follow?`<div class="notice" style="margin-bottom:12px"><div class="eyebrow">正在跟进</div><b>${esc(follow.clubName)}</b><div class="subtle" style="margin-top:5px">经纪人已联系该俱乐部，等待进一步回应。${esc(follow.date||'')}</div></div>`:''}<div class="section-head" style="margin-top:18px"><div><div class="eyebrow">CLUB INTEREST</div><h3>对你有兴趣的球队</h3></div></div>${interests.length?interests.map(o=>`<div class="notice" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px"><div><b>${esc(o.clubName)}</b><div class="subtle" style="margin-top:4px">${esc(o.countryName)} · ${esc(o.leagueName)} · 第${o.leagueTier}级</div></div><span class="badge">${o.status==='contacting'?'接洽中':o.status==='responded'?'已回应':o.status==='rejected'?'暂不推进':o.status==='declined'?'暂不考虑':'有兴趣'}</span></div><div class="subtle" style="margin-top:7px">预计定位：${o.estimatedRole==='rotation'?'轮换':'替补'} · 预估转会费 €${(o.estimatedFee||0).toLocaleString()} · 俱乐部声望 ${o.clubReputation}</div>${o.status==='contacting'?`<div class="subtle" style="margin-top:7px">经纪人已发出询问，预计 ${esc(o.responseDue||'近期')} 会收到俱乐部回应。</div>`:o.status==='responded'?`<div class="notice" style="margin-top:10px"><b>${esc(o.response||'俱乐部已回应')}</b><div class="subtle" style="margin-top:5px">${esc(o.responseDetail||'对方愿意继续讨论。')}</div><div class="actions" style="margin-top:9px"><button class="btn primary" data-agent-contract="1" data-club-id="${o.clubId}">${window.__selectedOfferClubId===o.clubId?'收起合同方案':'查看合同方案'}</button></div>${window.__selectedOfferClubId===o.clubId?(()=>{const offer=(p.transferOffers||[]).find(x=>x.clubId===o.clubId&&(x.type==='agent-interest'||x.type==='market-request'));const wage=offer?.weeklyWage??o.weeklyWage??Math.max(500,Math.round((p.contract?.weeklyWage||800)*1.08));const fee=offer?.transferFee??o.transferFee??Math.max(50000,Math.round((p.marketValue||0)*0.9/5000)*5000);const end=offer?.endDate??o.endDate??'';const role=offer?.role??o.role??'rotation';return `<div class="notice" style="margin-top:10px"><div class="eyebrow">CONTRACT PROPOSAL</div><h3 style="margin:5px 0 10px">${esc(o.clubName)} 合同方案</h3><div class="row"><span>球队</span><b>${esc(o.clubName)}</b></div><div class="row"><span>球队定位</span><b>${role==='regular'?'常规主力':'轮换球员'}</b></div><div class="row"><span>周薪</span><b>€${Number(wage).toLocaleString()}</b></div><div class="row"><span>转会费</span><b>€${Number(fee).toLocaleString()}</b></div><div class="row"><span>合同至</span><b>${esc(end||'待俱乐部确认')}</b></div><div class="subtle" style="margin-top:8px">${offer?'这是俱乐部正式生成的初步合同方案。':'合同方案正在生成，请稍后推进时间或重新进入经纪人页面。'}</div><div class="actions" style="margin-top:10px">${offer?`<button class="btn primary" data-agent-accept="${offer.id}" data-club-id="${offer.clubId}">接受合同并转会</button>`:'<button class="btn" disabled>等待正式报价</button>'}</div></div>`})():''}</div>`:o.status==='rejected'?`<div class="subtle" style="margin-top:7px">${esc(o.responseDetail||'这次接触暂时没有继续。')}</div>`:o.status==='declined'?'<div class="subtle" style="margin-top:7px">这次机会已暂时放弃。</div>':`<div class="actions" style="margin-top:10px"><button class="btn primary" data-agent-interest="consider" data-club-id="${o.clubId}">认真考虑</button><button class="btn" data-agent-interest="decline" data-club-id="${o.clubId}">暂不考虑</button></div>`}</div>`).join(''):`<div class="empty">目前没有明确兴趣。继续比赛和提升表现，经纪人会继续寻找合适球队。</div>`}</section></div>`}
  // ── 体格自定义的"界限"定义 ────────────────────────────────────────────────
  // 结论先说：world.js 里**没有争顶/对抗/头球模型**，attackH/attackA 是球队级期望进球
  // （hs/as 聚合 + 战术系数），单个球员的身高体重进不去任何数值公式。
  // 因此体格在本作里**只影响建模比例**（2D 头像 / 3D 模型 / 资料卡文字），不改 CA/PA 与六项能力。
  // 唯一的硬约束是"别拉出怪物"：身高体重按 BMI 区间联动，身材只映射到 body.build。
  const PHYS={ hMin:165, hMax:205, bmiMin:19.5, bmiMax:25.5 };
  const PHYS_BUILD=[[0.32,'偏瘦'],[0.5,'标准'],[0.68,'健壮'],[0.85,'强壮']];
  function bmiBand(hcm){ const m=Math.max(1.2,hcm/100); return [Math.round(PHYS.bmiMin*m*m), Math.round(PHYS.bmiMax*m*m)]; }
  function clampPhysWeight(hcm,wkg){ const b=bmiBand(hcm); return Math.max(b[0], Math.min(b[1], Math.round(wkg))); }

  // ── 自定义外观（2D 头像 / 3D 模型 / 资料卡共用同一份 appearanceOverride）────────────
  function appearanceEditor(){
    const p=FW.state.player;
    if(!p)return '<div class="grid"><section class="card"><div class="empty">先创建你的球员，再自定义外观。</div></section></div>';
    const L=(window.FWAvatar&&window.FWAvatar.lists)||null;
    if(!L)return '<div class="grid"><section class="card"><div class="empty">外观模块还在加载，稍后再试。</div></section></div>';
    const a=(window.FWAvatar&&window.FWAvatar.of)?window.FWAvatar.of(p):null;
    const ov=p.appearanceOverride||{};
    const cur={
      hair_style: ov.hair_style||(a&&a.hair_style)||'short',
      hair_color: ov.hair_color!=null?ov.hair_color:(a&&a.hair_color),
      skin_tone: ov.skin_tone!=null?ov.skin_tone:(a&&a.skinKey),
      facial_hair: ov.facial_hair||(a&&a.facial_hair)||'none',
    };
    const persona=(window.FW3D&&FW3D.appearance)?FW3D.appearance():{};
    const num=persona.number||9, foot=persona.dominantFoot||'right', celeb=persona.celebrate||'arms', boot=persona.boot||'#1b1f24';
    const opt=(v,label,sel)=>'<option value="'+esc(String(v))+'"'+(String(v)===String(sel)?' selected':'')+'>'+esc(label)+'</option>';
    const hairOpts=L.hairStyles.map(function(h){return opt(h.key,h.label,cur.hair_style)}).join('');
    const HAIR_CN={'jet-black':'乌黑','black':'黑','dark-brown':'深褐','brown':'褐','chestnut':'栗','auburn':'红褐','dark-blonde':'深金','blonde':'金','ginger':'姜红','grey':'灰白'};
    const hairColorOpts=L.hairColors.map(function(c){return opt(c.hex,HAIR_CN[c.key]||c.key,cur.hair_color)}).join('');
    const skinOpts=L.skinTones.map(function(s){return opt(s.key,s.label,cur.skin_tone)}).join('');
    const beardOpts=L.facialHair.map(function(f){return opt(f.key,f.label,cur.facial_hair)}).join('');
    const celebOpts=[['arms','张开双臂'],['knee','滑跪'],['slid','滑地庆祝'],['sky','指天']].map(function(c){return opt(c[0],c[1],celeb)}).join('');
    const footOpts=[['right','右脚'],['left','左脚']].map(function(c){return opt(c[0],c[1],foot)}).join('');
    const pv=(window.FWAvatar&&FWAvatar.svg)?FWAvatar.svg(p,{size:220}):'';
    const physH=Math.round(ov.height!=null?ov.height:(a&&a.height?a.height:180));
    const physBand=bmiBand(physH);
    const physW=clampPhysWeight(physH, ov.weight!=null?ov.weight:(a&&a.weight?a.weight:75));
    const physBuild=(ov.body&&Number.isFinite(ov.body.build))?ov.body.build:((a&&a.build!=null)?a.build:0.5);
    const buildOpts=PHYS_BUILD.map(function(c){return opt(c[0],c[1],physBuild)}).join('');
    const physBmi=(physW/Math.pow(physH/100,2));
    const physTxt='BMI '+physBmi.toFixed(1)+' · 体重参考区间 '+physBand[0]+'–'+physBand[1]+'kg · 只影响建模';
    const h=physH, w=physW, band=physBand;
    return '<div class="grid"><section class="card"><div class="section-head"><div><div class="eyebrow">APPEARANCE</div><h2>自定义外观</h2></div><button class="btn" id="app-reset">恢复默认</button></div>'
      +'<p class="muted">这里改的是你自己的外观覆盖，会随存档保存。2D 头像、3D 模型和资料卡读的是同一份数据，改完立刻一致。</p>'
      +'<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-top:12px">'
      +'<div id="app-preview" style="flex:0 0 auto;background:#1b212b;border-radius:14px;padding:10px">'+pv+'</div>'
      +'<div class="form" style="flex:1;min-width:280px">'
      +'<label>发型<select class="select" onchange="__appSetAppearance(\'hair_style\',this.value)">'+hairOpts+'</select></label>'
      +'<label>发色<select class="select" onchange="__appSetAppearance(\'hair_color\',this.value)">'+hairColorOpts+'</select></label>'
      +'<label>肤色<select class="select" onchange="__appSetAppearance(\'skin_tone\',this.value)">'+skinOpts+'</select></label>'
      +'<label>胡须<select class="select" onchange="__appSetAppearance(\'facial_hair\',this.value)">'+beardOpts+'</select></label>'
      +'</div>'
      +'<div class="form" style="flex:1;min-width:280px">'
      +'<label>球衣号码<input class="input" type="number" min="1" max="99" value="'+esc(String(num))+'" onchange="__appSetAppearance(\'number\',this.value)"></label>'
      +'<label>惯用脚<select class="select" onchange="__appSetAppearance(\'dominantFoot\',this.value)">'+footOpts+'</select></label>'
      +'<label>庆祝动作<select class="select" onchange="__appSetAppearance(\'celebrate\',this.value)">'+celebOpts+'</select></label>'
      +'<label>球鞋颜色<select class="select" onchange="__appSetAppearance(\'boot\',this.value)">'+[['#1b1f24','黑'],['#f4f5f7','白'],['#d23b3b','红'],['#2f6fd0','蓝'],['#e8c437','黄'],['#e26bb0','粉']].map(function(c){return opt(c[0],c[1],String(boot).toLowerCase())}).join('')+'</select></label>'
      +'</div>'
      +'<div class="form" style="flex:1;min-width:280px">'
      +'<label>身高 <b id="app-h-val">'+h+'cm</b><input class="input" id="app-h" type="range" min="'+PHYS.hMin+'" max="'+PHYS.hMax+'" step="1" value="'+h+'" onchange="__appSetAppearance(\'height\',this.value)"></label>'
      +'<label>体重 <b id="app-w-val">'+w+'kg</b><input class="input" id="app-w" type="range" min="'+band[0]+'" max="'+band[1]+'" step="1" value="'+w+'" onchange="__appSetAppearance(\'weight\',this.value)"></label>'
      +'<label>身材<select class="select" onchange="__appSetAppearance(\'build\',this.value)">'+buildOpts+'</select></label>'
      +'<div id="app-physique" class="subtle" style="margin-top:2px">'+physTxt+'</div>'
      +'</div></div>'
      +'<p class="subtle" style="margin-top:12px"><b>体格只影响建模比例（2D 头像 / 3D 模型），不改变任何能力数值</b>：CA/PA、六项能力、成长曲线都不动。身高体重按 BMI 区间联动，超出区间会自动拉回。</p>'
      +'<p class="subtle">发型 / 发色 / 肤色 / 胡须 / 身高 / 体重 / 身材写入存档；号码 / 惯用脚 / 庆祝动作 / 球鞋是 3D 比赛里的个性化设置（存在本机）。</p>'
      +'<div class="row" style="margin-top:14px"><span>返回</span><b><button class="btn" data-goto-player="1">回到球员页</button></b></div>'
      +'</section></div>';
  }
  window.__appSetAppearance=function(key,raw){
    const p=FW.state.player; if(!p)return null;
    if(key==='number'){ const n=Math.max(1,Math.min(99,parseInt(raw,10)||9)); if(window.FW3D&&FW3D.setAppearance)FW3D.setAppearance({number:n}); }
    else if(key==='dominantFoot'||key==='celebrate'){ if(window.FW3D&&FW3D.setAppearance)FW3D.setAppearance({[key]:raw}); }
    else if(key==='boot'){ if(window.FW3D&&FW3D.setAppearance)FW3D.setAppearance({boot:raw}); }
    else if(key==='height'||key==='weight'){
      const av=(window.FWAvatar&&FWAvatar.of)?FWAvatar.of(p):null;
      const curH=Math.round((p.appearanceOverride&&p.appearanceOverride.height)||(av&&av.height)||180);
      let hh=(key==='height')?Math.round(Number(raw)):curH;
      hh=Math.max(PHYS.hMin,Math.min(PHYS.hMax,hh));
      const band=bmiBand(hh);
      const rawW=(key==='weight')?Math.round(Number(raw)):((p.appearanceOverride&&p.appearanceOverride.weight)||(av&&av.weight)||75);
      const ww=Math.max(band[0],Math.min(band[1],rawW));
      FW.setPlayerAppearance({height:hh,weight:ww});
      if(window.saveState)try{window.saveState()}catch(e){}
      // 同步控件与读数（避免整页重渲染）
      try{
        const eh=document.getElementById('app-h-val'); if(eh)eh.textContent=hh+'cm';
        const ew=document.getElementById('app-w-val'); if(ew)ew.textContent=ww+'kg';
        const sl=document.getElementById('app-w'); if(sl){sl.min=band[0];sl.max=band[1];sl.value=ww;}
        const sh=document.getElementById('app-h'); if(sh)sh.value=hh;
        const rd=document.getElementById('app-physique'); if(rd)rd.textContent='BMI '+(ww/Math.pow(hh/100,2)).toFixed(1)+' · 体重参考区间 '+band[0]+'–'+band[1]+'kg · 只影响建模';
      }catch(e){}
      return FW.state.player.appearanceOverride||null;
    }
    else if(key==='build'){
      FW.setPlayerAppearance({body:{build:Number(raw)}});
      if(window.saveState)try{window.saveState()}catch(e){}
      return FW.state.player.appearanceOverride||null;
    }
    else {
      const patch={}; patch[key]=(key==='hair_color')?Number(raw):raw;
      FW.setPlayerAppearance(patch);
      if(window.saveState)try{window.saveState()}catch(e){}
    }
    // 刷新预览 + 让页面里的头像占位符重新填充
    try{
      const pv=document.getElementById('app-preview');
      if(pv&&window.FWAvatar)pv.innerHTML=FWAvatar.svg(FW.state.player,{size:220});
      document.querySelectorAll('.fw-avatar-slot').forEach(function(el){el.removeAttribute('data-fw-filled');el.innerHTML='';});
      if(window.__FWAPP&&window.__FWAPP.refillAvatars)window.__FWAPP.refillAvatars();
    }catch(e){}
    return FW.state.player.appearanceOverride||null;
  };
  function render(){shell(view==='home'?home():view==='player'?player():view==='matches'?matches():view==='market'?market():view==='playerDetail'?playerDetail():view==='clubDetail'?clubDetail():view==='national'?national():view==='matchday'?matchday():view==='agent'?agent():world())}
  let __soundBound=false;
  function bindSound(){
    if(__soundBound)return;
    __soundBound=true;
    document.addEventListener('click',function(e){
      const t=e.target&&e.target.closest?e.target.closest('button,[data-v],[data-pt],[data-world-club-id],[data-club-back],[data-goto-tab]'):null;
      if(!t)return;
      if(typeof FWSound==='undefined')return;
      FWSound.unlock();
      if(t.hasAttribute('data-sound')){return}
      if(t.hasAttribute('data-save')||t.hasAttribute('data-load'))return FWSound.play('confirm');
      if(t.hasAttribute('data-adv'))return FWSound.play('tick');
      if(t.hasAttribute('data-train'))return FWSound.play('train');
      if(t.hasAttribute('data-event-option')||t.hasAttribute('data-report-close'))return FWSound.play('confirm');
      if(t.hasAttribute('data-pt')||t.hasAttribute('data-v'))return FWSound.play('select');
      return FWSound.play('tap');
    },true);
  }
  // ── 快捷键帮助 ─────────────────────────────────────────────────────────
  function showShortcuts() {
    document.querySelectorAll('.keys-layer').forEach((x) => x.remove());
    const rows = [
      ['H', '首页'], ['P', '我的球员'], ['G', '目标 / 成就'], ['M', '比赛中心'],
      ['W', '世界'], ['N', '国家队'], ['T', '球员市场'], ['B', '经纪人'],
      ['1 / 2 / 3 / 4', '推进 +1 / +7 / +30 / +90 天'],
      ['J / K', '在球员页切换标签'],
      ['S / L', '存档 / 读档'],
      ['V', '开关音效'], ['L', '射门镭射图（最近一场）'], ['R', '能力放射对比（隐藏）'], ['Ctrl/⌘ + K 或 /', '命令面板'], ['?', '显示 / 关闭本帮助'], ['Esc', '关闭弹窗'],
    ];
    const layer = document.createElement('div');
    layer.className = 'career-layer keys-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog keys-dialog" role="dialog" aria-modal="true">'
      + '<div class="focus-kicker">SHORTCUTS</div><h2>快捷键</h2>'
      + '<div class="keys-grid">' + rows.map(([k, d]) => '<div class="keys-row"><kbd>' + k + '</kbd><span>' + d + '</span></div>').join('') + '</div>'
      + '<div style="margin-top:16px"><button class="btn primary" data-keys-close="1">知道了</button></div></div>';
    document.body.appendChild(layer);
    const close = () => layer.remove();
    layer.querySelector('[data-keys-close]').onclick = close;
    layer.querySelector('.focus-backdrop').onclick = close;
  }
  // ── 射门镭射图（隐藏玩法：按 L 查看最近一场）─────────────────────────
  function shotMapSVG(match, width) {
    const W = width || 420, H = Math.round(W * 0.62);
    const home = match.homeClubId, away = match.awayClubId;
    const stats = match.stats || {};
    const seed = String(match.id || 'x');
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    const shotsHome = (stats.shots && stats.shots.home) || 0;
    const shotsAway = (stats.shots && stats.shots.away) || 0;
    const goals = (match.events || []).filter((e) => e.type === 'goal');
    const dots = [];
    const drawShot = (side, count, isGoal) => {
      const color = isGoal ? (side === 'home' ? 'var(--c1,#C8102E)' : '#D97706') : 'rgba(20,24,32,.20)';
      for (let i = 0; i < count; i++) {
        // 主队从左侧进攻，客队镜像
        let x = 0.06 + rnd() * 0.34, y = 0.15 + rnd() * 0.7;
        x = 0.04 + Math.pow(rnd(), 1.6) * 0.34;
        const px = side === 'home' ? x * W : (1 - x) * W;
        const py = y * H;
        const r = 2 + rnd() * 3;
        dots.push('<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + color + '" stroke="' + (isGoal ? 'rgba(255,255,255,.9)' : 'none') + '" stroke-width="' + (isGoal ? '1.2' : '0') + '" opacity="' + (isGoal ? '.98' : '.6') + '"/>');
      }
    };
    const gh = goals.filter((g) => g.team === 'home').length;
    const ga = goals.filter((g) => g.team === 'away').length;
    drawShot('home', Math.max(0, shotsHome - gh), false);
    drawShot('away', Math.max(0, shotsAway - ga), false);
    drawShot('home', gh, true);
    drawShot('away', ga, true);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="射门镭射图">'
      + '<rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" rx="8" fill="rgba(120,180,140,.10)" stroke="rgba(20,60,40,.18)"/>'
      + '<line x1="' + (W / 2) + '" y1="3" x2="' + (W / 2) + '" y2="' + (H - 3) + '" stroke="rgba(20,60,40,.16)"/>'
      + '<circle cx="' + (W / 2) + '" cy="' + (H / 2) + '" r="' + (H * 0.12) + '" fill="none" stroke="rgba(20,60,40,.16)"/>'
      + '<rect x="1" y="' + (H / 2 - H * 0.2) + '" width="' + (W * 0.12) + '" height="' + (H * 0.4) + '" fill="none" stroke="rgba(20,60,40,.16)"/>'
      + '<rect x="' + (W - 1 - W * 0.12) + '" y="' + (H / 2 - H * 0.2) + '" width="' + (W * 0.12) + '" height="' + (H * 0.4) + '" fill="none" stroke="rgba(20,60,40,.16)"/>'
      + dots + '</svg>';
  }

  function showShotMap(match) {
    document.querySelectorAll('.shot-layer').forEach((x) => x.remove());
    if (!match) { alert('还没有可以分析的比赛'); return; }
    const home = FW.clubName(match.homeClubId), away = FW.clubName(match.awayClubId);
    const st = match.stats || {};
    const layer = document.createElement('div');
    layer.className = 'career-layer shot-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog shot-dialog" role="dialog" aria-modal="true">'
      + '<div class="focus-kicker">SHOT MAP · LASER</div><h2 style="margin:6px 0 4px">射门镭射图</h2>'
      + '<div class="subtle">' + esc(match.date) + ' · ' + esc(home) + ' ' + match.score.home + '-' + match.score.away + ' ' + esc(away) + '</div>'
      + '<div class="shot-pitch" style="' + clubVars(match.homeClubId) + '">' + shotMapSVG(match, 520) + '</div>'
      + '' + '<div class="shot-legend"><span><i class="sd solid"></i>' + esc(home) + ' 进球</span><span><i class="sd away"></i>' + esc(away) + ' 进球</span><span><i class="sd hollow"></i>未进球射门</span><span class="subtle">越靠中间＝位置越好</span></div>' + ''
      + '<div class="row"><span>' + esc(home) + ' 射门</span><b>' + ((st.shots && st.shots.home) || 0) + '（xG ' + ((st.xg && st.xg.home) || '—') + '）</b></div>'
      + '<div class="row"><span>' + esc(away) + ' 射门</span><b>' + ((st.shots && st.shots.away) || 0) + '（xG ' + ((st.xg && st.xg.away) || '—') + '）</b></div>'
      + '<div style="margin-top:16px"><button class="btn primary" data-shot-close="1">关闭</button></div></div>';
    document.body.appendChild(layer);
    layer.querySelector('[data-shot-close]').onclick = () => layer.remove();
    layer.querySelector('.focus-backdrop').onclick = () => layer.remove();
    if (typeof FWSound !== 'undefined') FWSound.play('select');
  }

  // ── 命令面板（Ctrl+K）──────────────────────────────────────────────────
  function showPalette() {
    document.querySelectorAll('.palette-layer').forEach((x) => x.remove());
    const layer = document.createElement('div');
    layer.className = 'career-layer palette-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="palette-box"><input id="pal-input" class="input" placeholder="搜索页面 / 俱乐部 / 球员…" autocomplete="off"><div id="pal-list" class="pal-list"></div><div class="pal-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div></div>';
    document.body.appendChild(layer);
    const input = layer.querySelector('#pal-input');
    const list = layer.querySelector('#pal-list');
    const pages = [['首页', 'home'], ['我的球员', 'player'], ['目标与成就', null], ['比赛中心', 'matches'], ['世界', 'world'], ['国家队', 'national'], ['球员市场', 'market'], ['经纪人', 'agent']];
    let items = [];
    let active = 0;
    const build = (q) => {
      const query = String(q || '').trim().toLowerCase();
      const out = [];
      for (const [label, v] of pages) {
        if (!query || label.includes(query)) out.push({ kind: '页面', label, act: () => { if (label === '目标与成就') { navTo('player'); playerTab = 'goals'; } else if (v) view = v; renderImmediate(); } });
      }
      if (query) {
        for (const c of Object.values(FW.state.clubs)) {
          if (out.length > 40) break;
          if (c.name.includes(query)) out.push({ kind: '俱乐部', label: c.name, act: () => { window.__selectedClubId = c.id; navTo('clubDetail'); renderImmediate(); } });
        }
        for (const p of Object.values(FW.state.players)) {
          if (out.length > 70) break;
          if (p.name.includes(query)) out.push({ kind: '球员', label: p.name + ' · ' + (p.position || '') + ' · ' + FW.clubName(p.clubId), act: () => { window.__selectedPlayerId = p.id; navTo('playerDetail'); renderImmediate(); } });
        }
      }
      items = out.slice(0, 70);
      active = 0;
      paint();
    };
    const paint = () => {
      list.innerHTML = items.length ? items.map((it, i) => '<button class="pal-item' + (i === active ? ' on' : '') + '" data-pal-i="' + i + '"><span class="pal-kind">' + it.kind + '</span><span>' + esc(it.label) + '</span></button>').join('') : '<div class="empty">没有匹配结果</div>';
      const cur = list.querySelector('.pal-item.on');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    };
    const run = (i) => { const it = items[i]; if (!it) return; layer.remove(); it.act(); };
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-pal-i]'); if (b) run(Number(b.dataset.palI)); });
    input.addEventListener('input', () => build(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(active); }
      else if (e.key === 'Escape') { e.preventDefault(); layer.remove(); }
    });
    build('');
    setTimeout(() => input.focus(), 30);
  }
  // ── 放射对比图（隐藏：按 R）──────────────────────────────────────────
  function radialCompareSVG(b, size) {
    const S = size || 300, cx = S / 2, cy = S / 2, R = S * 0.36;
    const keys = b.keys, labels = { speed: '速度', shooting: '射门', passing: '传球', control: '控球', defense: '防守', stamina: '体能' };
    const pt = (i, r) => { const a = (Math.PI * 2 * i) / keys.length - Math.PI / 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
    let grid = '';
    for (const f of [0.25, 0.5, 0.75, 1]) {
      grid += '<polygon points="' + keys.map((k, i) => pt(i, R * f).join(',')).join(' ') + '" fill="none" stroke="rgba(20,24,32,.08)" stroke-width="1"/>';
    }
    const spokes = keys.map((k, i) => { const [x, y] = pt(i, R); return '<line x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '" stroke="rgba(20,24,32,.07)"/>'; }).join('');
    const poly = (vals, attrs) => {
      const p = keys.map((k, i) => pt(i, (R * Math.max(4, Math.min(100, vals[k] || 0))) / 100).join(',')).join(' ');
      return '<polygon points="' + p + '" ' + attrs + '/>';
    };
    const dots = keys.map((k, i) => {
      const [x, y] = pt(i, (R * Math.max(4, Math.min(100, b.self[k] || 0))) / 100);
      return '<circle cx="' + x + '" cy="' + y + '" r="2.8" fill="var(--c1,#2F4858)"/>';
    }).join('');
    const texts = keys.map((k, i) => {
      const [x, y] = pt(i, R + 18);
      const delta = Math.round((b.self[k] || 0) - (b.squadAvg[k] || 0));
      const tone = delta >= 0 ? '#1a7f47' : '#b3261e';
      return '<text x="' + x + '" y="' + (y + 3) + '" text-anchor="middle" font-size="10" fill="rgba(35,40,50,.6)">' + labels[k] + '</text>'
        + '<text x="' + x + '" y="' + (y + 15) + '" text-anchor="middle" font-size="9.5" fill="' + tone + '">' + (delta >= 0 ? '+' : '') + delta + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + S + ' ' + S + '" width="100%" height="' + S + '" role="img" aria-label="放射对比图">'
      + grid + spokes
      + poly(b.leagueAvg, 'fill="rgba(20,24,32,.04)" stroke="rgba(20,24,32,.28)" stroke-width="1" stroke-dasharray="4 3"')
      + poly(b.squadAvg, 'fill="rgba(74,125,252,.08)" stroke="rgba(74,125,252,.55)" stroke-width="1.2" stroke-dasharray="5 3"')
      + poly(b.self, 'fill="color-mix(in srgb, var(--c1,#2F4858) 18%, transparent)" stroke="var(--c1,#2F4858)" stroke-width="1.6" stroke-linejoin="round"')
      + dots + texts + '</svg>';
  }

  function showRadialCompare() {
    document.querySelectorAll('.radial-layer').forEach((x) => x.remove());
    const p = FW.state.player;
    if (!p || !p.stats) { alert('先创建球员'); return; }
    const b = FW.attributeBenchmark ? FW.attributeBenchmark(p) : null;
    if (!b) { alert('暂时无法对比'); return; }
    const names = { speed: '速度', shooting: '射门', passing: '传球', control: '控球', defense: '防守', stamina: '体能' };
    const rows = b.keys.map((k) => {
      const d = Math.round((b.self[k] || 0) - (b.squadAvg[k] || 0));
      const d2 = Math.round((b.self[k] || 0) - (b.leagueAvg[k] || 0));
      return '<div class="row"><span>' + names[k] + '</span><b>' + Math.round(b.self[k] || 0)
        + ' <span style="color:' + (d >= 0 ? '#1a7f47' : '#b3261e') + '">' + (d >= 0 ? '+' : '') + d + '</span>'
        + ' <span class="subtle">队 / 联赛 ' + (d2 >= 0 ? '+' : '') + d2 + '</span></b></div>';
    }).join('');
    const layer = document.createElement('div');
    layer.className = 'career-layer radial-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog radial-dialog" role="dialog" aria-modal="true" style="' + clubVars(p.clubId) + '">'
      + '<div class="focus-kicker">RADIAL COMPARE</div><h2 style="margin:6px 0 2px">能力放射对比</h2>'
      + '<div class="subtle">你的六维 vs 队内平均（' + b.squadSize + ' 人）vs 联赛平均</div>'
      + '<div class="radial-pitch">' + radialCompareSVG(b, 300) + '</div>'
      + '<div class="radial-legend"><span><i class="rl me"></i>你</span><span><i class="rl squad"></i>队内平均</span><span><i class="rl league"></i>联赛平均</span></div>'
      + rows
      + (b.weakKey ? '<div class="notice" style="margin-top:12px"><b>训练建议：' + names[b.weakKey] + '</b><div class="subtle" style="margin-top:4px">与你位置的平均水平相差 ' + b.weakGap + '，是目前最值得补的一环。</div><div class="actions" style="margin-top:10px"><button class="btn primary" data-goto-tab="training" data-radial-close="1">去训练</button><button class="btn" data-radial-close="1">关闭</button></div></div>' : '')
      + '</div>';
    document.body.appendChild(layer);
    layer.querySelectorAll('[data-radial-close]').forEach((b2) => { b2.onclick = () => layer.remove(); });
    layer.querySelector('.focus-backdrop').onclick = () => layer.remove();
    if (typeof FWSound !== 'undefined') FWSound.play('select');
  }
  // ── 新球队/新联赛简报 ───────────────────────────────────────────────
  function showBriefing(clubId) {
    document.querySelectorAll('.brief-layer').forEach((x) => x.remove());
    const b = FW.clubBriefing ? FW.clubBriefing(clubId) : null;
    if (!b) return;
    const lg = FW.leagueBriefing ? FW.leagueBriefing(b.leagueId) : null;
    const rankText = b.leagueRank ? '当前第 ' + b.leagueRank + ' / ' + b.leagueSize : '赛季尚未开始';
    const layer = document.createElement('div');
    layer.className = 'career-layer brief-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog brief-dialog" role="dialog" aria-modal="true" style="' + clubVars(clubId) + '">'
      + '<div class="focus-kicker">NEW CLUB</div>'
      + '<h2 style="margin:6px 0 2px">' + esc(b.name) + '</h2>'
      + '<div class="subtle">' + esc(b.nameEn || '') + (b.city ? ' · ' + esc(b.city) : '') + '</div>'
      + '<div class="brief-home"><span class="team-mark">' + esc(b.name[0] || 'C') + '</span><div>'
      + '<div class="row"><span>主场</span><b>' + esc(b.stadium || '—') + (b.capacity ? ' · ' + b.capacity.toLocaleString() : '') + '</b></div>'
      + '<div class="row"><span>联赛</span><b>' + esc(b.leagueName) + '</b></div>'
      + '<div class="row"><span>排名</span><b>' + esc(rankText) + '</b></div>'
      + '<div class="row"><span>声望</span><b>' + b.reputation + '</b></div>'
      + (b.coach ? '<div class="row"><span>主教练</span><b>' + esc(b.coach) + (b.style ? ' · ' + esc(b.style) : '') + '</b></div>' : '')
      + (b.budget ? '<div class="row"><span>转会预算</span><b>€' + Number(b.budget).toLocaleString() + '</b></div>' : '')
      + '</div></div>'
      + (lg ? '<div class="brief-block"><div class="brief-title">联赛赛制</div>' + lg.lines.map((x) => '<div class="brief-line">· ' + esc(x) + '</div>').join('') + '</div>' : '')
      + (b.stars && b.stars.length ? '<div class="brief-block"><div class="brief-title">队内核心</div>' + b.stars.map((s) => '<div class="brief-line"><b>' + esc(s.name) + '</b> <span class="subtle">' + esc(s.position) + ' · CA ' + s.ca + '</span></div>').join('') + '</div>' : '')
      + (lg && lg.teams.length ? '<div class="brief-block"><div class="brief-title">联赛前列</div><div class="brief-table">' + lg.teams.map((t) => '<div class="brief-tr"><span>' + t.rank + '</span><span>' + esc(t.name) + '</span><b>' + t.points + '</b></div>').join('') + '</div></div>' : '')
      + '<div class="actions" style="margin-top:14px"><button class="btn primary" data-brief-close="1">知道了</button></div></div>';
    document.body.appendChild(layer);
    layer.querySelectorAll('[data-brief-close]').forEach((x) => { x.onclick = () => layer.remove(); });
    layer.querySelector('.focus-backdrop').onclick = () => layer.remove();
    const p = FW.state.player;
    if (p && p.career && p.career.pendingBriefing) p.career.pendingBriefing.seen = true;
    if (typeof FWSound !== 'undefined') FWSound.play('enter');
  }

  function maybeShowBriefing() {
    const p = FW.state.player;
    if (!p || !p.career || !p.career.pendingBriefing) return false;
    const b = p.career.pendingBriefing;
    if (b.seen) return false;
    if (document.querySelector('.brief-layer')) return false;
    setTimeout(() => showBriefing(b.clubId), 260);
    return true;
  }
  // ── 国家队入选通知 ────────────────────────────────────────────────
  function showCallup(){
    document.querySelectorAll('.callup-layer').forEach(x=>x.remove());
    const p=FW.state.player;
    if(!p||!p.nationalTeam||!p.nationalTeam.invitation)return;
    const inv=p.nationalTeam.invitation;
    const country=inv.country||p.nationality;
    const nt=FW.state.nationalTeams[country]||{};
    const squadSize=(nt.squadIds||[]).length;
    const layer=document.createElement('div');
    layer.className='career-layer callup-layer';
    layer.innerHTML='<div class="focus-backdrop"></div><div class="focus-dialog callup-dialog" role="dialog" aria-modal="true" style="'+flagVars(country)+'">'
      +'<div class="callup-badge">NATIONAL CALL-UP</div>'
      +'<h2 style="margin:8px 0 4px">你入选了 '+esc(country)+' 国家队</h2>'
      +'<div class="subtle">'+esc(nt.coach?nt.coach.name:country+'国家队主教练')+' 将你列入本期 '+squadSize+' 人名单。</div>'
      +'<div class="kpi" style="margin-top:14px"><div class="k"><b>'+squadSize+'</b><span>本期名单</span></div><div class="k"><b>'+(p.nationalTeam.caps||0)+'</b><span>国家队出场</span></div><div class="k"><b>'+Math.round(p.ca||0)+'</b><span>当前能力</span></div></div>'
      +'<div class="callup-note">接受征召后会随队参加国际比赛，出场与进球计入国家队履历；拒绝不会影响俱乐部，但可能影响下一期征召。</div>'
      +'<div class="actions" style="margin-top:16px"><button class="btn primary" data-callup="accepted">接受征召</button><button class="btn" data-callup="declined">暂不接受</button></div>'
      +'</div>';
    document.body.appendChild(layer);
    if(typeof FWSound!=='undefined')FWSound.play('enter');
    layer.querySelectorAll('[data-callup]').forEach(b=>b.onclick=()=>{
      const choice=b.dataset.callup;
      p.nationalTeam.consent=choice;
      p.nationalTeam.invitation={...inv,status:choice,answered:true,notified:true};
      if(choice==='accepted'){
        const team=FW.state.nationalTeams[p.nationality];
        if(team&&!team.squadIds.includes(p.id))team.squadIds.push(p.id);
        p.nationalTeam.callups=(p.nationalTeam.callups||0)+1;
      }
      layer.remove();
      if(typeof FWSound!=='undefined')FWSound.play(choice==='accepted'?'confirm':'tap');
      renderAnimated();autoSave();
    });
  }
  function maybeShowCallup(){
    const p=FW.state.player;
    if(!p||!p.nationalTeam||!p.nationalTeam.invitation)return false;
    const inv=p.nationalTeam.invitation;
    if(inv.status!=='pending'||inv.notified)return false;
    if(document.querySelector('.callup-layer'))return false;
    inv.notified=true;
    setTimeout(()=>showCallup(),360);
    return true;
  }
  let __keysBound=false;
  // ── 比赛回放 ───────────────────────────────────────────────────────────
  let __replayTimer = null;
  function showMatchReplay(match) {
    document.querySelectorAll('.replay-layer').forEach((x) => x.remove());
    const homeName = FW.clubName(match.homeClubId), awayName = FW.clubName(match.awayClubId);
    const events = (match.events || []).slice().sort((a, b) => a.minute - b.minute);
    const layer = document.createElement('div');
    layer.className = 'career-layer replay-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog replay-dialog" role="dialog" aria-modal="true">'
      + '<div class="focus-kicker">MATCH REPLAY</div>'
      + '<div class="replay-head"><div class="replay-team" style="' + clubVars(match.homeClubId) + '"><span class="team-mark">' + esc(homeName[0] || 'H') + '</span><b>' + esc(homeName) + '</b></div>'
      + '<div class="replay-score"><strong id="rp-score">0 - 0</strong><span id="rp-clock">0′</span></div>'
      + '<div class="replay-team away" style="' + clubVars(match.awayClubId) + '"><span class="team-mark">' + esc(awayName[0] || 'A') + '</span><b>' + esc(awayName) + '</b></div></div>'
      + '<div class="replay-bar"><i id="rp-fill"></i></div>'
      + '<div class="replay-feed" id="rp-feed"><div class="replay-empty">开球…</div></div>'
      + '<div class="replay-foot"><div class="subtle" id="rp-stats"></div><div style="display:flex;gap:8px"><button class="btn" id="rp-play">播放</button><button class="btn primary" data-replay-close="1">关闭</button></div></div>'
      + '</div>';
    document.body.appendChild(layer);
    const scoreEl = layer.querySelector('#rp-score');
    const clockEl = layer.querySelector('#rp-clock');
    const fillEl = layer.querySelector('#rp-fill');
    const feedEl = layer.querySelector('#rp-feed');
    const playBtn = layer.querySelector('#rp-play');
    const statsEl = layer.querySelector('#rp-stats');
    let homeGoals = 0, awayGoals = 0, revealed = 0, minute = 0;
    const stat = match.stats || {};
    const fmtStats = () => '控球 ' + (stat.possession ? stat.possession.home + '% - ' + stat.possession.away + '%' : '—')
      + ' · 射门 ' + ((stat.shots && (stat.shots.home + ' - ' + stat.shots.away)) || '—')
      + ' · xG ' + ((stat.xg && (stat.xg.home.toFixed(2) + ' - ' + stat.xg.away.toFixed(2))) || '—');

    const EVENT_LABEL={goal:'进球',yellow:'黄牌',red:'红牌',substitution:'换人',injury:'伤退',penalty:'点球',own_goal:'乌龙球'};
    function pushEvent(ev) {
      const holder=feedEl.querySelector('.replay-empty');
      if(holder)holder.remove();
      const isHome = ev.team === 'home';
      const icon = ev.type === 'goal' ? '⚽' : ev.type === 'yellow' ? '🟨' : ev.type === 'red' ? '🟥' : ev.type === 'substitution' ? '🔄' : ev.type === 'injury' ? '🩹' : '•';
      const name=ev.scorer||ev.player||ev.playerName||'';
      const label=(EVENT_LABEL[ev.type]||'事件')+(name?(' · '+esc(name)):'');
      if (ev.type === 'goal') { if (isHome) homeGoals++; else awayGoals++; scoreEl.textContent = homeGoals + ' - ' + awayGoals; }
      const row = document.createElement('div');
      row.className = 'replay-row' + (isHome ? ' home' : ' away') + (ev.type === 'goal' ? ' goal' : '');
      row.innerHTML = '<span class="rp-min">' + ev.minute + '′</span><span class="rp-icon">' + icon + '</span><span class="rp-text">' + label + '</span><span class="rp-side">' + esc(isHome ? homeName : awayName) + '</span>';
      feedEl.appendChild(row);
      if (typeof FWSound !== 'undefined') FWSound.play(ev.type === 'goal' ? 'goal' : 'tap');
    }

    function tick() {
      minute += 2;
      if (minute > 90) minute = 90;
      clockEl.textContent = minute + '′';
      fillEl.style.width = (minute / 90 * 100) + '%';
      while (revealed < events.length && events[revealed].minute <= minute) { pushEvent(events[revealed]); revealed++; }
      if (minute >= 90) {
        clearInterval(__replayTimer); __replayTimer = null;
        playBtn.textContent = '重播';
        statsEl.textContent = fmtStats();
        if (typeof FWSound !== 'undefined') FWSound.play('whistle');
      }
    }

    function start() {
      clearInterval(__replayTimer);
      homeGoals = 0; awayGoals = 0; revealed = 0; minute = 0;
      scoreEl.textContent = '0 - 0'; clockEl.textContent = '0′'; fillEl.style.width = '0%';
      feedEl.innerHTML = '<div class="replay-empty">开球…</div>';
      statsEl.textContent = '';
      playBtn.textContent = '暂停';
      __replayTimer = setInterval(tick, 55);
    }

    playBtn.onclick = () => {
      if (__replayTimer) { clearInterval(__replayTimer); __replayTimer = null; playBtn.textContent = '继续'; return; }
      if (clockEl.textContent === '90′') { feedEl.innerHTML = ''; }
      if (playBtn.textContent === '继续') { playBtn.textContent = '暂停'; __replayTimer = setInterval(tick, 55); return; }
      start();
    };
    layer.querySelector('[data-replay-close]').onclick = () => { clearInterval(__replayTimer); __replayTimer = null; layer.remove(); };
    start();
  }
  // ── 存档位选择 ─────────────────────────────────────────────────────────
  function showSaveSlots(mode) {
    document.querySelectorAll('.slot-layer').forEach((x) => x.remove());
    const layer = document.createElement('div');
    layer.className = 'career-layer slot-layer';
    layer.innerHTML = '<div class="focus-backdrop"></div><div class="focus-dialog slot-dialog" role="dialog" aria-modal="true"><div class="focus-kicker">SAVE SLOTS</div><h2>' + (mode === 'save' ? '保存到哪个存档位？' : '读取哪个存档位？') + '</h2><div id="slot-list" class="slot-list"><div class="subtle">读取中…</div></div><div style="margin-top:16px"><button class="btn" data-slot-close="1">取消</button></div></div>';
    document.body.appendChild(layer);
    layer.querySelector('[data-slot-close]').onclick = () => layer.remove();
    const list = layer.querySelector('#slot-list');
    FWStore.list().then((slots) => {
      list.innerHTML = slots.map((s) => {
        const m = s.meta || {};
        const desc = s.exists
          ? (m.date || '') + ' · ' + (m.season || '') + (m.player ? ' · ' + esc(m.player) + '@' + esc(m.club || '') : '')
          : '空存档位';
        const sub = s.exists ? (new Date(m.at || 0).toLocaleString('zh-CN') + ' · ' + (s.bytes ? Math.round(s.bytes / 1024) + ' KB' : '')) : '';
        return '<button class="slot-row" data-slot="' + s.slot + '"' + (s.exists ? '' : ' data-empty="1"') + '><span class="slot-no">' + s.slot + '</span><span class="slot-main"><b>' + desc + '</b><span class="subtle">' + sub + '</span></span><span class="slot-act">' + (mode === 'save' ? '保存' : (s.exists ? '读取' : '空')) + '</span></button>';
      }).join('');
      list.querySelectorAll('[data-slot]').forEach((b) => {
        b.onclick = async () => {
          const slot = Number(b.dataset.slot);
          if (mode === 'save') {
            if (b.dataset.empty === undefined && !confirm('覆盖存档位 ' + slot + ' 吗？')) return;
            b.querySelector('.slot-act').textContent = '保存中…';
            try { const ok = await autoSave(true, slot); b.querySelector('.slot-act').textContent = ok ? '已保存' : '失败'; setTimeout(() => layer.remove(), 600); }
            catch (e) { b.querySelector('.slot-act').textContent = '失败'; }
          } else {
            if (b.dataset.empty !== undefined) { alert('这个存档位是空的'); return; }
            try {
              const rec = await FWStore.load(slot);
              if (!rec) { alert('读取失败：存档位为空'); return; }
              if (!confirm('读取存档位 ' + slot + ' 会覆盖当前进度（' + (rec.meta.date || '') + ' · ' + (rec.meta.player || '无球员') + '），确定吗？')) return;
              FW.loadState(rec.json);
              renderImmediate();
              layer.remove();
              if (typeof FWSound !== 'undefined') FWSound.play('confirm');
            } catch (e) { alert('读档失败：' + e.message); }
          }
        };
      });
    }).catch((e) => { list.innerHTML = '<div class="subtle">存档系统不可用：' + esc(e.message) + '</div>'; });
  }
  function bindKeys(){
    if(__keysBound)return;
    __keysBound=true;
    document.addEventListener('keydown',function(e){
      if(e.key==='k'&&(e.metaKey||e.ctrlKey)){e.preventDefault();showPalette();return}
      if(e.metaKey||e.ctrlKey||e.altKey)return;
      const tag=(e.target&&e.target.tagName)||'';
      if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||e.target.isContentEditable)return;
      const map={'1':1,'2':7,'3':30,'4':90};
      if(map[e.key]){
        const b=document.querySelector('[data-adv="'+map[e.key]+'"]');
        if(b){e.preventDefault();b.click()}
        return;
      }
      const k=e.key.toLowerCase();
      if(e.key==='?'||(e.shiftKey&&e.key==='/')){e.preventDefault();showShortcuts();return}
      if(e.key==='Escape'){document.querySelectorAll('.career-layer,.keys-layer').forEach(x=>x.remove());return}
      const NAV={h:'home',p:'player',g:null,m:'matches',w:'world',n:'national',t:'market',b:'agent'};
      if(NAV[k]!==undefined){
        e.preventDefault();
        if(k==='g'){view='player';playerTab='goals';renderImmediate();window.scrollTo&&window.scrollTo(0,0);return}
        view=NAV[k];renderImmediate();window.scrollTo&&window.scrollTo(0,0);
        if(typeof FWSound!=='undefined')FWSound.play('select');
        return;
      }
      if(k==='j'||k==='k'){
        const order=['overview','goals','training','matches','career','ability'];
        const idx=Math.max(0,order.indexOf(playerTab));
        const next=order[(idx+(k==='j'?1:order.length-1))%order.length];
        view='player';playerTab=next;renderImmediate();
        if(typeof FWSound!=='undefined')FWSound.play('select');
        return;
      }
      if(e.key==='/'){e.preventDefault();showPalette();return}
      if(k==='l'){const ms=(FW.state.matches||[]).filter(m=>m.status==='completed').slice(-1)[0];showShotMap(ms);return}
      if(k==='r'){showRadialCompare();return}
      if(k==='s'){const b=document.querySelector('[data-save]');if(b){e.preventDefault();b.click()}}
      else if(k==='l'){const b=document.querySelector('[data-load]');if(b){e.preventDefault();b.click()}}
      else if(k==='v'){const b=document.querySelector('[data-sound]');if(b){e.preventDefault();b.click()}}
    });
  }
  function bind(){
    (function mountScout(){
      var host=document.getElementById("fw3d-scout")||document.querySelector(".matchday-card");
      if(!host)return;
      if(host.querySelector(".scout-panel"))return;
      var intel=null, oppId=null;
      try{
        var lg=FW.state.player&&FW.state.player.clubId?FW.state.clubs[FW.state.player.clubId]:null;
        var league=lg?FW.state.leagues.find(function(l){return l.id===lg.leagueId}):null;
        if(league){ oppId=(league.clubIds||[]).find(function(id){return id!==lg.id}); }
        if(oppId&&FW.state.scoutIntel) intel=FW.state.scoutIntel[oppId];
        if(!intel&&oppId&&FW.scoutingReport) intel=FW.scoutingReport(oppId);
      }catch(e){}
      if(!intel)return;
      var box=document.createElement("div");
      box.className="notice scout-panel";
      box.style.marginTop="12px";
      var t=document.createElement("b");
      t.textContent="下一个对手：" + (intel.name||"");
      box.appendChild(t);
      var d=document.createElement("div");
      d.className="subtle";
      d.style.marginTop="5px";
      d.textContent=intel.intel;
      box.appendChild(d);
      var acts=document.createElement("div");
      acts.className="actions";
      acts.style.marginTop="8px";
      var b1=document.createElement("button");
      b1.className="btn";
      b1.textContent="按情报布置战术";
      b1.onclick=function(){ try{ var r=FW.applyScoutTip(oppId); if(r&&r.ok){ renderAnimated(); } }catch(e){} };
      acts.appendChild(b1);
      if(FW.state.playerMatchPlan&&FW.state.playerMatchPlan.scoutTip){
        var tag=document.createElement("span");
        tag.className="badge";
        tag.textContent="已按情报布置";
        acts.appendChild(tag);
      }
      box.appendChild(acts);
      host.appendChild(box);
    })();
    (function mount3DEntry(){
      var host=document.getElementById("fw3d-entry")||document.querySelector(".matchday-card");
      if(!host)return;
      if(host.querySelector(".fw3d-panel"))return;
      var ok=(typeof FW3D!=="undefined" && FW3D.canRun ? FW3D.canRun() : (FW3D&&FW3D.available&&FW3D.available()));
      var box=document.createElement("div");
      box.className="notice fw3d-panel";
      box.style.marginTop="12px";
      var title=document.createElement("b");
      title.textContent="3D 现场";
      box.appendChild(title);
      var desc=document.createElement("div");
      desc.className="subtle";
      desc.style.marginTop="5px";
      desc.textContent=ok?"从球员通道走进球场，第一人称踢这一场。文字界面随时可以回来。":"当前浏览器或显卡不支持 WebGL，3D 已自动关闭，文字赛事功能不受影响。";
      box.appendChild(desc);
      if(ok){
        var acts=document.createElement("div");
        acts.className="actions";
        acts.style.marginTop="10px";
        [["tunnel","到场（通道出场）"],["pitch","直接上场"],["spectate","坐替补席观赛"]].forEach(function(pair,idx){
          var b=document.createElement("button");
          b.className=idx===0?"btn primary":"btn";
          b.textContent=pair[1];
          if(pair[0]==="spectate") b.title="第一视角坐在替补席看这场球：可以起立走动、到场边、去对面替补席或看台；场上进不去";
          b.onclick=function(){
            if(typeof FW3D==="undefined"||!FW3D.open) return;
            FW3D.open(pair[0]==="tunnel"?{mode:"tunnel"}:(pair[0]==="spectate"?{mode:"spectate"}:{}));
          };
          acts.appendChild(b);
        });
        box.appendChild(acts);
        var dlab=document.createElement("div");
        dlab.className="subtle";
        dlab.style.marginTop="10px";
        dlab.textContent="操作难度（只影响判定容差，不改能力值）";
        box.appendChild(dlab);
        var drows=document.createElement("div");
        drows.className="actions";
        drows.style.marginTop="6px";
        var cur=(FW.state&&FW.state.difficulty)||"standard";
        [["casual","休闲"],["standard","标准"],["hardcore","硬核"]].forEach(function(pair){
          var b=document.createElement("button");
          b.className="chip-btn"+(cur===pair[0]?" on":"");
          b.textContent=pair[1];
          b.onclick=function(){ if(FW.setDifficulty)FW.setDifficulty(pair[0]); renderAnimated(); };
          drows.appendChild(b);
        });
        box.appendChild(drows);
      }
      host.appendChild(box);
    })();

    document.querySelectorAll('[data-nt-id]').forEach(b=>b.onclick=(e)=>{e.stopPropagation();window.__selectedNtId=b.dataset.ntId;navTo('ntDetail')});

    document.querySelectorAll('[data-cup-id]').forEach(b=>b.onclick=(e)=>{e.stopPropagation();window.__selectedCupId=b.dataset.cupId;navTo('cupDetail')});

    document.querySelectorAll('[data-comp-filter]').forEach(b=>b.onclick=()=>{window.__compFilter=b.dataset.compFilter;renderAnimated()});

    document.querySelectorAll('[data-match-more]').forEach(b=>b.onclick=()=>{window.__matchLimit=(window.__matchLimit||((window.innerWidth<760)?8:40))+8;renderAnimated()});

    document.querySelectorAll('[data-world-more]').forEach(b=>b.onclick=()=>{window.__worldLimit=(window.__worldLimit||(window.innerWidth<760?2:6))+6;renderAnimated()});

    document.querySelectorAll('[data-comp-id]').forEach(b=>b.onclick=(e)=>{e.stopPropagation();window.__selectedCompId=b.dataset.compId;window.__compRound=0;navTo('competitionDetail')});
    document.querySelectorAll('[data-comp-round]').forEach(b=>b.onclick=()=>{window.__compRound=Number(b.dataset.compRound);renderAnimated()});
    document.querySelectorAll('[data-nation-id]').forEach(b=>b.onclick=(e)=>{e.stopPropagation();const id=b.dataset.nationId;if(!id)return;window.__selectedNation=id;navTo('nationalDetail')});

    document.querySelectorAll('[data-market-more]').forEach(b=>b.onclick=()=>{window.__marketLimit=(window.__marketLimit||120)+120;renderAnimated()});
    document.querySelectorAll('[data-market-reset]').forEach(b=>{if(!b.onclick)b.onclick=()=>{window.__marketLimit=0;renderAnimated()}});

    document.querySelectorAll('[data-country]').forEach(b=>b.onclick=()=>{window.__worldCountry=b.dataset.country;renderAnimated()});

    document.querySelectorAll('[data-create-mode]').forEach(b=>b.onclick=()=>{window.__createMode=b.dataset.createMode;renderAnimated()});
    document.querySelectorAll('[data-create-stage]').forEach(b=>b.onclick=()=>{window.__createStage=b.dataset.createStage;renderAnimated()});
    const realq=document.getElementById('realq');
    if(realq){realq.oninput=()=>{window.__realQuery=realq.value};realq.onkeydown=(e)=>{if(e.key==='Enter'){window.__realQuery=realq.value;renderAnimated()}}}
    document.querySelectorAll('[data-real-pick]').forEach(b=>b.onclick=()=>{
      if(!confirm('以这位球员的身份开始生涯？原 NPC 会被移除。'))return;
      const r=FW.createPlayerFromReal(b.dataset.realPick);
      if(!r||!r.ok){alert('开局失败：'+((r&&r.reason)||'未知原因'));return}
      view='player';playerTab='overview';renderAnimated();autoSave();
    });

    document.querySelectorAll('[data-briefing]').forEach(b=>b.onclick=()=>showBriefing(FW.state.player&&FW.state.player.clubId));

    document.querySelectorAll('[data-agent-act]').forEach(b=>b.onclick=()=>{
      const r=FW.agentAction(FW.state.player,b.dataset.agentAct);
      if(!r.ok){alert(r.reason==='no-actions'?'本月委托次数已用完，推进时间后恢复':'暂时无法执行这个操作');return}
      alert(r.text);
      if(typeof FWSound!=='undefined')FWSound.play(r.success?'confirm':'hurt');
      renderImmediate();
    });

    document.querySelectorAll('[data-laser]').forEach(b=>b.onclick=(e)=>{e.stopPropagation();const m=(FW.state.matches||[]).find(x=>x.id===b.dataset.laser);showShotMap(m)});

    document.querySelectorAll('[data-help]').forEach(b=>b.onclick=()=>showShortcuts());

    document.querySelectorAll('[data-replay]').forEach(b=>b.onclick=()=>{
      const m=(FW.state.matches||[]).find(x=>x.id===b.dataset.replay);
      if(!m){alert('这场比赛已经不在明细里了');return}
      showMatchReplay(m);
    });

    document.querySelectorAll('[data-retire]').forEach(b=>b.onclick=()=>{
      if(!confirm('确定要宣布退役吗？退役后可以查看生涯总结，并开始新的一段生涯。'))return;
      const r=FW.retirePlayer();
      if(!r.ok){alert('现在还不能退役：'+r.reason);return}
      pushHallOfFame(r.summary);
      renderImmediate();
      showRetireSummary(r.summary);
    });

    document.querySelectorAll('[data-sound]').forEach(b=>{b.onclick=()=>{if(typeof FWSound==='undefined')return;const on=FWSound.toggle();const ic=b.querySelector('.sound-icon');if(ic)ic.textContent=on?'\u{1F50A}':'\u{1F507}';b.classList.toggle('muted',!on);b.title=on?'音效已开启':'音效已关闭'}});
    document.querySelectorAll('[data-sound]').forEach(b=>{if(typeof FWSound==='undefined')return;const on=FWSound.enabled;const ic=b.querySelector('.sound-icon');if(ic)ic.textContent=on?'\u{1F50A}':'\u{1F507}';b.classList.toggle('muted',!on)});
    document.querySelectorAll('[data-goto-tab]').forEach(b=>b.onclick=()=>{playerTab=b.dataset.gotoTab;navTo('player');return;window.scrollTo&&window.scrollTo(0,0)});
document.querySelectorAll('[data-goto-appearance]').forEach(b=>b.onclick=()=>{navTo('appearance')});
document.querySelectorAll('[data-goto-player]').forEach(b=>b.onclick=()=>{playerTab='overview';navTo('player')});
    document.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>showSaveSlots('save'));
document.querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>showSaveSlots('load'));
document.querySelectorAll('[data-national-consent]').forEach(b=>b.onclick=()=>{const r=FW.setNationalConsent(b.dataset.nationalConsent);if(r&&r.ok)renderAnimated();else alert('无法更新征召状态');});
    document.querySelectorAll('[data-world-country]').forEach(b=>b.onclick=()=>{window.__worldCountry=b.dataset.worldCountry;renderAnimated()});
document.querySelectorAll('[data-back]').forEach(b=>b.onclick=()=>{goBack()});document.querySelectorAll('[data-world-club-id]').forEach(b=>b.onclick=()=>{window.__selectedClubId=b.dataset.worldClubId;navTo('clubDetail')});document.querySelectorAll('[data-club-back]').forEach(b=>b.onclick=()=>{navTo('world')});document.querySelectorAll('[data-player-id]').forEach(b=>b.onclick=()=>{window.__selectedPlayerId=b.dataset.playerId;navTo('playerDetail')});document.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>{view=b.dataset.v;renderAnimated()});document.querySelectorAll('button').forEach(b=>{b.addEventListener('pointerdown',()=>b.classList.add('pressing'));b.addEventListener('pointerup',()=>b.classList.remove('pressing'));b.addEventListener('pointercancel',()=>b.classList.remove('pressing'));b.addEventListener('pointerleave',()=>b.classList.remove('pressing'))});document.querySelectorAll('[data-adv]').forEach(b=>b.onclick=()=>{if(advanceBusy)return;const days=+b.dataset.adv;const items=FW.upcomingFocusMatches(FW.addDays(FW.state.date,days));if(items.length){showFocusPrompt(items,days);return;}advanceBusy=true;try{
      const __before=(FW.state.player&&FW.state.player.careerStats)?FW.state.player.careerStats.goals||0:0;
      const __injuryBefore=FW.state.player&&FW.state.player.injury?FW.state.player.injury.name:null;
      FW.advance(days);
      if(typeof FWSound!=='undefined'&&FW.state.player){
        const __after=FW.state.player.careerStats?FW.state.player.careerStats.goals||0:0;
        if(__after>__before){FWSound.play('goal');if(typeof window.__fwGoalFlash==='function')window.__fwGoalFlash()}
        else if(FW.state.player.injury&&FW.state.player.injury.name!==__injuryBefore)FWSound.play('hurt');
        else FWSound.play('whistle');
      }
      renderImmediate();if(window.autoSave)autoSave()}catch(e){console.error(e);alert('时间推进出现异常，请继续尝试；当前页面不会锁死。')}finally{advanceBusy=false}});document.querySelectorAll('[data-plan-key]').forEach(b=>b.onclick=()=>{const cur=FW.state.playerMatchPlan||{tactic:'平衡',focus:'平衡',subPlan:'正常'};FW.setPlayerMatchPlan({...cur,[b.dataset.planKey]:b.dataset.planValue});renderAnimated()});document.querySelectorAll('[data-match-request]').forEach(b=>b.onclick=()=>{const result=FW.requestPlayerMatchDecision(b.dataset.matchRequest);if(result.ok){alert(result.accepted?'教练接受了你的请求。':'教练没有接受你的请求。');renderAnimated()}});document.querySelectorAll('[data-adv-until]').forEach(b=>b.onclick=()=>{if(advanceBusy)return;const f=FW.nextPlayerFixture();if(!f)return;advanceBusy=true;try{FW.advance(Math.max(1,Math.ceil((new Date(f.date+'T00:00:00Z')-new Date(FW.state.date+'T00:00:00Z'))/86400000)));renderImmediate();if(window.autoSave)autoSave();if(FW.state.lastCareerOutcome){const outcome=FW.state.lastCareerOutcome;FW.state.lastCareerOutcome=null;showCareerOutcome(outcome);}}catch(e){console.error(e);alert('时间推进出现异常，请继续尝试；当前页面不会锁死。')}finally{advanceBusy=false}});document.querySelectorAll('[data-pt]').forEach(b=>b.onclick=()=>{playerTab=b.dataset.pt;try{renderAnimated()}catch(e){console.error(e);try{renderImmediate()}catch(e2){alert('页面暂时无法显示，请重新进入我的球员。')}}});const c=document.getElementById('create');if(c)c.onclick=()=>{if(c.dataset.busy==='1')return;c.dataset.busy='1';try{const res=FW.createPlayer({name:(document.getElementById('pn').value||'').trim()||'新球员',position:document.getElementById('pp').value,nationality:(document.getElementById('pnat')||{}).value||window.__createNationality||Object.keys(FW.COUNTRY_PROFILES)[0],clubId:document.getElementById('pc').value,stage:window.__createStage||'prospect'});if(!res||!res.ok){alert('创建失败：'+((res&&res.reason)||'未知原因'));return}view='player';playerTab='overview';renderAnimated();autoSave()}finally{c.dataset.busy='0'}};const nationalitySelect=document.getElementById('pnat');if(nationalitySelect)nationalitySelect.onchange=()=>{window.__createNationality=nationalitySelect.value;renderAnimated()};document.querySelectorAll('[data-plan-type]').forEach(b=>b.onclick=()=>{window.__trainingPlanType=b.dataset.planType;renderAnimated()});document.querySelectorAll('[data-plan-days]').forEach(b=>b.onclick=()=>{const type=window.__trainingPlanType||'技术';const result=FW.startTrainingPlan(type,+b.dataset.planDays);if(result.ok)renderAnimated()});document.querySelectorAll('[data-stop-training-plan]').forEach(b=>b.onclick=()=>{FW.stopTrainingPlan();renderAnimated()});document.querySelectorAll('[data-train]').forEach(b=>b.onclick=()=>{const result=FW.trainPlayer(b.dataset.train);if(result.ok){window.__lastTraining=result;renderAnimated()}else if(result.reason==='already-trained'){alert('今天已经训练过了。先推进时间，或者选择休息。')}});document.querySelectorAll('[data-market-search]').forEach(b=>b.onclick=()=>{window.__marketQuery=document.getElementById('mq')?.value||'';window.__marketPos=document.getElementById('mp')?.value||'ALL';window.__marketAge=document.getElementById('ma')?.value||0;window.__marketCA=document.getElementById('mc')?.value||0;window.__marketLeague=document.getElementById('ml')?.value||'ALL';renderAnimated()});document.querySelectorAll('[data-market-reset]').forEach(b=>b.onclick=()=>{window.__marketQuery='';window.__marketPos='ALL';window.__marketAge=0;window.__marketCA=0;window.__marketLeague='ALL';renderAnimated()});document.querySelectorAll('[data-market-request]').forEach(b=>b.onclick=()=>{const result=FW.requestMarketClub(b.dataset.marketRequest);if(result.ok)renderAnimated();else if(result.reason==='already-contacting')alert('已经向这家俱乐部发出申请。')});document.querySelectorAll('[data-player-detail]').forEach(b=>b.onclick=()=>{window.__selectedPlayerId=b.dataset.playerDetail;navTo('playerDetail')});document.querySelectorAll('[data-clear-match-report]').forEach(b=>b.onclick=()=>{FW.state.lastPlayerMatchId=null;FW.state.lastPlayerMatchDate=null;navTo('matches')});document.querySelectorAll('[data-career-choice]').forEach(b=>b.onclick=()=>{const result=FW.chooseCareerEvent(b.dataset.careerChoice);if(result.ok)renderAnimated()});document.querySelectorAll('[data-agent-interest]').forEach(b=>b.onclick=()=>{const result=FW.chooseAgentInterest(b.dataset.clubId,b.dataset.agentInterest);if(result.ok)renderAnimated()});document.querySelectorAll('[data-agent-contract]').forEach(b=>b.onclick=()=>{const id=b.dataset.clubId||'';window.__selectedOfferClubId=window.__selectedOfferClubId===id?'':id;renderAnimated()});document.querySelectorAll('[data-offers]').forEach(b=>b.onclick=()=>{FW.refreshTransferOffers();renderAnimated()});document.querySelectorAll('[data-agent-accept]').forEach(b=>b.onclick=()=>{const result=FW.acceptTransfer(b.dataset.agentAccept);if(result.ok){window.__selectedOfferClubId='';view='player';playerTab='overview';alert('转会完成');renderAnimated()}else{const msg={
'offer-not-found':'合同方案已失效，请重新查看合同方案。',
'club-not-found':'目标俱乐部不存在。',
'insufficient-budget':'该俱乐部当前转会预算不足，暂时无法完成这笔转会。',
'no-player':'请先创建球员。'
}[result.reason]||'转会暂时无法完成。';alert(msg)}});document.querySelectorAll('[data-accept]').forEach(b=>b.onclick=()=>{const result=FW.acceptTransfer(b.dataset.accept);if(result.ok){window.__selectedOfferClubId='';view='player';playerTab='overview';alert('转会完成');renderAnimated()}else{const msg={'offer-not-found':'报价已失效，请重新查看合同方案。','club-not-found':'目标俱乐部不存在。','insufficient-budget':'该俱乐部当前转会预算不足，暂时无法完成转会。','no-player':'请先创建球员。'}[result.reason]||'转会暂时无法完成。';alert(msg)}})}
  // 顶部导航在页面滚动时切换成毛玻璃样式（原版调用了一个不存在的函数）
  let __navGlassBound = false;
  function ensureNavGlass() {
    try {
      const nav = document.querySelector('.nav');
      if (!nav) return;
      const apply = () => {
        const y = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
        if (y > 8) nav.classList.add('nav-scrolled'); else nav.classList.remove('nav-scrolled');
      };
      apply();
      if (!__navGlassBound) {
        __navGlassBound = true;
        window.addEventListener('scroll', () => {
          const n = document.querySelector('.nav');
          if (!n) return;
          const y = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
          if (y > 8) n.classList.add('nav-scrolled'); else n.classList.remove('nav-scrolled');
        }, { passive: true });
      }
    } catch (e) { /* 忽略：滚动效果失败不影响游戏 */ }
  }

  // ── 视图历史：返回只回到上一个界面 ───────────────────────────────
  const viewStack=[];
  function snapshotView(){
    return {view,playerTab,scroll:window.scrollY||0,
      club:window.__selectedClubId||null,player:window.__selectedPlayerId||null,
      comp:window.__selectedCompId||null,nation:window.__selectedNation||null};
  }
  function navTo(next,opts){
    if(!next)return;
    if(next!==view||(opts&&opts.force)){
      viewStack.push(snapshotView());
      if(viewStack.length>30)viewStack.shift();
    }
    view=next;
    try{renderImmediate();}catch(e){console.error(e)}
  }
  function goBack(){
    const prev=viewStack.pop();
    if(prev){
      view=prev.view;playerTab=prev.playerTab||'overview';
      window.__selectedClubId=prev.club||null;window.__selectedPlayerId=prev.player||null;
      window.__selectedCompId=prev.comp||null;window.__selectedNation=prev.nation||null;
      try{renderImmediate()}catch(e){console.error(e)}
      if(typeof prev.scroll==='number')setTimeout(()=>window.scrollTo(0,prev.scroll),0);
    }else{
      // 没有历史时回到首页（例如直接打开详情页）
      view='home';playerTab='overview';renderImmediate();
    }
  }
  // 调试钩子：方便自动化测试直接切换页面
  window.__FWAPP = {
    setView: (v) => { navTo(v,{force:true}); },
    setTab: (t) => { playerTab = t; renderImmediate(); },
    getView: () => view,
    html: () => (document.getElementById('app') || {}).innerHTML || '',
    // 立刻重画当前页（index.html 里一直在调 __FWAPP.render，但这个方法以前根本不存在 → 空调用）
    render: () => { try { renderImmediate(); return true; } catch (e) { return false; } },
    // 强制重画所有头像占位符：转会换队、改外观之后必须重画 ——
    // 否则桥接脚本的 fillAvatars() 会因为 data-fw-filled 已存在而跳过，头像停在旧俱乐部球衣上
    refillAvatars: () => {
      try { if (window.FWAvatar && window.FWAvatar.refill) return window.FWAvatar.refill(); } catch (e) {}
      return false;
    },
  };

  FW.makeWorld();renderImmediate();ensureNavGlass();bindSound();bindKeys();
  window.__fwGoalFlash=function(){
    try{
      const el=document.createElement('div');
      el.className='goal-flash';
      document.body.appendChild(el);
      setTimeout(()=>el.remove(),1000);
    }catch(e){}
  };
})();
