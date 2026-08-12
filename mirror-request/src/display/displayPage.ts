/**
 * The room screen (D-05/D-12): every TV opens this same URL and renders
 * whatever event is currently active. Screens carry no identity of their own,
 * so there is no per-screen token, slug, or query parameter to configure —
 * re-pointing a TV means changing the active event in the CMS, not touching
 * the TV.
 *
 * Phase 8 plan 08-01 adds only the CONFIG APPLIER below (the seam through
 * which CMS-01's per-event branding reaches the screen). The full room-screen
 * rebuild — hero moment, slideshow, reconnect banner — is plan 08-02; this
 * file is deliberately still Phase 5's layout everywhere else.
 */
export function renderDisplayPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Booth Queue</title>
  <style>
    /* CMS-01: the --event-* custom properties are the ONLY themeable surface.
       Their values here are the shipped defaults (DEFAULT_EVENT_CONFIG in
       localStore.ts, mirrored from 08-UI-SPEC's Room Screen default theme), so
       the screen renders correctly on first paint — before the first WS
       snapshot has arrived and before any event exists at all (UI-01). The
       applier below only ever overwrites these five values and the font. */
    :root{
      --event-bg:#0a0a0f;--event-surface:#13131a;--event-accent:#6c8fff;
      --event-text:#f5f5f7;--event-text-muted:#9a9aa8;
      --event-font:system-ui,-apple-system,"Segoe UI",sans-serif;
      --ink:var(--event-text);--paper:var(--event-bg);--accent:var(--event-accent);
      --muted:var(--event-text-muted);--line:rgba(245,245,247,.16)
    }
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow:hidden}
    body{background:var(--paper);color:var(--ink);font-family:var(--event-font)}
    body:after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.25'/%3E%3C/svg%3E")}
    main{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 23rem;padding:4.5vw;gap:5vw}
    .stage{display:flex;flex-direction:column;justify-content:space-between;min-width:0}
    .eyebrow{display:flex;align-items:center;gap:.75rem;text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:clamp(.75rem,1vw,1rem)}
    .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent);box-shadow:0 0 0 .35rem rgba(255,91,61,.16)}
    .hero{padding:4vh 0}.label{font-size:clamp(1rem,1.6vw,1.5rem);color:var(--muted);margin:0 0 1rem}
    h1{font-family:Didot,"Bodoni 72",Georgia,serif;font-size:clamp(4rem,10vw,10rem);font-weight:500;line-height:.87;letter-spacing:-.065em;margin:0;max-width:12ch;overflow-wrap:anywhere}
    .callout{display:flex;align-items:center;gap:2rem;margin-top:3rem;min-height:7rem}
    .count{display:grid;place-items:center;width:clamp(6rem,10vw,9rem);aspect-ratio:1;border:3px solid var(--ink);border-radius:50%;font-family:Didot,Georgia,serif;font-size:clamp(3rem,6vw,5.5rem);line-height:1;transition:transform .2s}
    .count.pulse{animation:pulse .8s ease-out}.instruction{font-size:clamp(1.2rem,2vw,2rem);max-width:20ch;line-height:1.2}
    .idle{font-family:Didot,Georgia,serif;font-size:clamp(2.5rem,5vw,5rem);max-width:13ch;line-height:1.05}
    aside{border-left:1px solid var(--line);padding-left:2.5rem;display:flex;flex-direction:column}
    aside h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.18em;margin:0 0:2.5rem}
    ol{list-style:none;padding:0;margin:0}.guest{display:grid;grid-template-columns:2.4rem 1fr;gap:1rem;padding:1.15rem 0;border-top:1px solid var(--line);align-items:baseline}.guest:first-child{border-top:2px solid var(--ink)}
    .pos{color:var(--accent);font-weight:800}.name{font-family:Didot,Georgia,serif;font-size:clamp(1.25rem,2vw,1.8rem)}
    /* The two operational status colours are HARD-CODED, never var(--event-*),
       and must stay that way: an event's branding must never be able to
       recolour "Agent mất kết nối" into something that reads as normal
       (08-UI-SPEC: fixed, non-configurable system-status roles). */
    .status{margin-top:auto;padding-top:2rem;color:var(--muted);font-size:.9rem}.online{color:#34d399}.offline{color:#a33127}
    @keyframes pulse{0%{transform:scale(1.12);background:var(--accent);color:var(--paper)}100%{transform:scale(1)}}
    @media(max-width:800px){main{grid-template-columns:1fr;padding:2rem}aside{display:none}h1{font-size:clamp(4rem,18vw,8rem)}}
  </style>
</head>
<body>
<main>
  <section class="stage">
    <div class="eyebrow"><span class="dot"></span><span id="state">Đang kết nối</span></div>
    <div class="hero" id="hero"><p class="idle">Vui lòng chờ lượt chụp tiếp theo.</p></div>
    <div id="queueMeta">Hàng chờ đang được cập nhật…</div>
  </section>
  <aside><h2>Thứ tự tiếp theo</h2><ol id="queue"></ol><div class="status" id="agent"></div></aside>
</main>
<script>
  const hero=document.querySelector('#hero'),queue=document.querySelector('#queue'),state=document.querySelector('#state'),agent=document.querySelector('#agent'),meta=document.querySelector('#queueMeta');
  let previousCount=null;
  // CMS-01: the config applier. Runs on EVERY snapshot rather than once at
  // load, which is what makes activating an event in the CMS re-theme every
  // connected screen live — no reload, no per-screen URL (D-12).
  //
  // The map below is an explicit allow-list of the five themeable colour
  // roles plus the font. It is not a loop over the snapshot's keys on
  // purpose: setProperty() with an attacker- or operator-supplied property
  // NAME would let a future config field write any custom property on the
  // document, including the ones holding the fixed operational colours.
  const FONTS={'system-ui':'system-ui,-apple-system,"Segoe UI",sans-serif'};
  function applyEventConfig(cfg){
    if(!cfg)return;
    const root=document.documentElement.style;
    root.setProperty('--event-bg',cfg.colorDominant);
    root.setProperty('--event-surface',cfg.colorSecondary);
    root.setProperty('--event-accent',cfg.colorAccent);
    root.setProperty('--event-text',cfg.colorText);
    root.setProperty('--event-text-muted',cfg.colorTextMuted);
    root.setProperty('--event-font',FONTS[cfg.fontChoice]||FONTS['system-ui']);
  }
  function render(data){
    applyEventConfig(data.eventConfig);
    state.textContent=data.boothState==='ANNOUNCING'?'Chuẩn bị vào vị trí':data.boothState==='BUSY'?'Đang chụp':'Sẵn sàng';
    agent.className='status '+(data.agentOnline?'online':'offline');agent.textContent=data.agentOnline?'● Agent đang kết nối':'● Agent mất kết nối';
    meta.textContent=data.queueLength?data.queueLength+' khách đang chờ':'Chưa có khách trong hàng chờ';
    queue.innerHTML=(data.upNext||[]).map(g=>'<li class="guest"><span class="pos">'+String(g.position).padStart(2,'0')+'</span><span class="name"></span></li>').join('');
    [...queue.querySelectorAll('.name')].forEach((el,i)=>el.textContent=data.upNext[i].name);
    if(data.boothState==='ANNOUNCING'&&data.guestName){
      hero.innerHTML='<p class="label">Xin mời khách tiếp theo</p><h1 id="guest"></h1><div class="callout"><div class="count" id="count"></div><p class="instruction">Chuẩn bị trước máy ảnh — phiên chụp sắp bắt đầu.</p></div>';
      document.querySelector('#guest').textContent=data.guestName;const count=document.querySelector('#count');count.textContent=data.countdownSeconds??'';
      if(previousCount!==data.countdownSeconds){count.classList.add('pulse');previousCount=data.countdownSeconds}
    }else if(data.boothState==='BUSY') hero.innerHTML='<p class="idle">Đang chụp ảnh.<br>Hãy nhìn vào ống kính.</p>';
    else{
      // UI-01: the idle state, carrying the active event's copy. Written with
      // textContent, never innerHTML — the heading and sub are
      // operator-authored strings, and interpolating them as markup would
      // turn the CMS config form into a stored-XSS path onto every TV.
      const cfg=data.eventConfig||{};
      hero.innerHTML='<p class="idle" id="idleHeading"></p><p class="label" id="idleSub"></p>';
      hero.querySelector('#idleHeading').textContent=cfg.idleHeading||'Sẵn sàng chụp ảnh cùng bạn';
      hero.querySelector('#idleSub').textContent=cfg.idleSub||'Quét mã QR bên dưới để đăng ký';
    }
  }
  function connect(){const protocol=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(protocol+'://'+location.host+'/display');ws.onmessage=e=>render(JSON.parse(e.data).data);ws.onclose=()=>setTimeout(connect,1500);ws.onerror=()=>ws.close()};connect();
</script>
</body></html>`;
}
