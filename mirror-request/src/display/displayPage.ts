/**
 * The room screen (D-05/D-12): every TV opens this same URL and renders
 * whatever event is currently active. Screens carry no identity of their own,
 * so there is no per-screen token, slug, or query parameter to configure —
 * re-pointing a TV means changing the active event in the CMS, not touching
 * the TV.
 *
 * ZERO BUILD STEP, ZERO NETWORK AT RENDER TIME. The whole screen — markup,
 * stylesheet and behaviour — is this one template string, served inline. There
 * is no bundler, no framework and, deliberately, not a single external
 * reference: no CDN, no Google Fonts link, no remote stylesheet. A venue whose
 * wifi is saturated or absent must render exactly what a connected one does
 * (T-08-SC). The only bytes a browser fetches beyond this document are the
 * self-hosted fonts under /assets/fonts and the event's own images.
 *
 * A note for anyone editing this file: it is one template literal, so a
 * BACKTICK anywhere inside it — including inside a comment — terminates the
 * string and breaks the build. Quote identifiers with 'single quotes' in
 * comments here, not backticks.
 */

/**
 * UI-SPEC Open Question 2 (answered): exactly one layout ships this phase —
 * the incumbent's proven stage+sidebar two-column grid. The `layout_style`
 * field exists in the event schema so a later phase can add layouts without a
 * migration, but there is no second branch here and no test matrix for layouts
 * that do not exist.
 */
export const SHIPPED_LAYOUT_STYLE = 'stage_sidebar';

export function renderDisplayPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Booth Queue</title>
  <style>
    /* The three curated fonts (08-UI-SPEC Open Question 1, human-answered),
       SELF-HOSTED and served by this service from /assets/fonts. There is no
       <link> to a font CDN anywhere in this document and there must never be
       one: a live event cannot depend on venue wifi reaching a third party to
       render a guest's name (T-08-SC).

       Weights 400 and 700 only — the two the Room Screen type scale uses.
       Every file is the full-coverage build, not the "vietnamese" subset:
       that subset carries ONLY the Vietnamese-specific codepoints, so a name
       built from it would render its ordinary letters in a fallback face and
       its diacritics in this one, mid-word. Coverage is verified against each
       file's cmap table in test/display-room-screen.test.ts rather than
       assumed (RESEARCH A4).

       font-display:swap so text is legible immediately on a cold cache; the
       screen never shows an invisible-text flash to a room. */
    @font-face{font-family:"Be Vietnam Pro";font-style:normal;font-weight:400;font-display:swap;
      src:url("/assets/fonts/be-vietnam-pro-400.woff2") format("woff2")}
    @font-face{font-family:"Be Vietnam Pro";font-style:normal;font-weight:700;font-display:swap;
      src:url("/assets/fonts/be-vietnam-pro-700.woff2") format("woff2")}
    @font-face{font-family:"Lora";font-style:normal;font-weight:400;font-display:swap;
      src:url("/assets/fonts/lora-400.woff2") format("woff2")}
    @font-face{font-family:"Lora";font-style:normal;font-weight:700;font-display:swap;
      src:url("/assets/fonts/lora-700.woff2") format("woff2")}

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
      --surface:var(--event-surface);--muted:var(--event-text-muted);
      --line:rgba(245,245,247,.16);
      /* 08-UI-SPEC Room Screen type scale: four fluid roles, two weights.
         Every size below is a clamp() because the physical size and aspect of
         the screen are unknown at build time — a portrait 43" and a landscape
         75" both get this same document. */
      --t-caption:clamp(.75rem,1vw,1rem);
      --t-label:clamp(1rem,1.6vw,1.5rem);
      --t-heading:clamp(1.25rem,2vw,1.8rem);
      --t-display:clamp(2.5rem,8vw,8rem)
    }
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow:hidden}
    body{background:var(--paper);color:var(--ink);font-family:var(--event-font);font-weight:400;line-height:1.4}
    body:after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.25'/%3E%3C/svg%3E")}

    /* The one shipped layout: stage_sidebar. 4.5vw fluid outer margin, not a
       fixed token — the proven value from both incumbents. */
    main{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 23rem;padding:4.5vw;gap:5vw}
    .stage{display:flex;flex-direction:column;justify-content:space-between;min-width:0;min-height:0}

    .eyebrow{display:flex;align-items:center;gap:.75rem;text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:var(--t-caption)}
    .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent);box-shadow:0 0 0 .35rem rgba(108,143,255,.16)}
    .hero{padding:4vh 0;min-height:0;display:flex;flex-direction:column;justify-content:center}
    .label{font-size:var(--t-label);color:var(--muted);margin:0 0 1rem}

    /* Long Vietnamese names with diacritics SHRINK TO FIT here rather than
       truncating: a guest's name is the one string on this screen that must
       never be cut. overflow-wrap:anywhere plus the fluid display clamp is the
       proven pairing. The sidebar rows use the opposite rule — see .qname. */
    h1{font-size:var(--t-display);font-weight:700;line-height:1.05;letter-spacing:-.03em;margin:0;max-width:14ch;overflow-wrap:anywhere}
    .callout{display:flex;align-items:center;gap:2rem;margin-top:3rem;min-height:7rem}
    .count{display:grid;place-items:center;width:clamp(6rem,10vw,9rem);aspect-ratio:1;border:3px solid var(--ink);border-radius:50%;font-size:clamp(3rem,6vw,5.5rem);font-weight:700;line-height:1;transition:transform .2s}
    .count.pulse{animation:pulse .8s ease-out}
    .instruction{font-size:var(--t-label);max-width:22ch;line-height:1.2}
    .idle{font-size:var(--t-display);font-weight:700;max-width:13ch;line-height:1.05;margin:0;overflow-wrap:anywhere}

    /* D-09 hero moment, and D-10 slideshow: the same tile, because they are
       the same thing seen at different ages. */
    .shot{display:flex;flex-direction:column;gap:1.5rem;min-height:0;flex:1}
    .frame{flex:1;min-height:0;display:grid;place-items:center;background:var(--surface);border-radius:.75rem;overflow:hidden;position:relative}
    .frame img{max-width:100%;max-height:100%;object-fit:contain}
    .shotname{font-size:var(--t-display);font-weight:700;line-height:1.05;margin:0;max-width:16ch;overflow-wrap:anywhere}
    .badge{position:absolute;top:1rem;left:1rem;background:var(--accent);color:var(--paper);font-size:var(--t-caption);font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.35rem 1rem;border-radius:2rem}
    .dots{display:flex;gap:.5rem;justify-content:center;padding-top:1rem}
    .pip{width:.5rem;height:.5rem;border-radius:50%;background:var(--line)}
    .pip.on{width:1.6rem;border-radius:.25rem;background:var(--ink)}

    /* G4's sibling: a photo that fails to load gets a neutral tile with a
       warning icon AND a visible Vietnamese label — never the browser's
       broken-image glyph, which reads as "this screen is broken". */
    .broken{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;width:100%;height:100%;color:var(--muted)}
    .broken svg{opacity:.35}
    .broken span{font-size:var(--t-label)}
    /* The incumbent web-slide initials avatar, carried forward for a name-only
       tile: a person's initials, never a blank box. */
    .avatar{width:clamp(5rem,9vw,8rem);aspect-ratio:1;border-radius:50%;background:var(--accent);color:var(--paper);display:grid;place-items:center;font-size:clamp(2rem,4vw,3.5rem);font-weight:700}

    aside{border-left:1px solid var(--line);padding-left:2.5rem;display:flex;flex-direction:column;min-height:0}
    /* margin is "0 0 2.5rem", not "0 0:2.5rem". The stray colon (pre-existing
       since Phase 5, logged as deferred item D-1 during 08-01) made the whole
       declaration invalid, so this heading silently had no bottom margin. */
    aside h2{font-size:var(--t-caption);font-weight:700;text-transform:uppercase;letter-spacing:.18em;margin:0 0 2.5rem}
    /* Capped visible rows + scroll: the sidebar never grows the page however
       many guests are queued (T-08-11). Bounded independently of the wire's
       own 5-row cap in getQueuedGuestSummaries(). */
    ol{list-style:none;padding:0;margin:0;max-height:58vh;overflow-y:auto}
    .guest{display:grid;grid-template-columns:2.4rem minmax(0,1fr);gap:1rem;padding:1.15rem 0;border-top:1px solid var(--line);align-items:baseline}
    .guest:first-child{border-top:2px solid var(--ink)}
    .pos{color:var(--accent);font-weight:700;font-size:var(--t-caption)}
    /* The OPPOSITE rule to the hero name above, and deliberately so: a
       space-constrained list row truncates with an ellipsis and keeps the full
       string in title=, rather than wrapping and pushing the list around. */
    .qname{font-size:var(--t-heading);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .qempty{color:var(--muted);font-size:var(--t-label)}
    .meta{font-size:var(--t-label);color:var(--muted)}

    /* The two operational status colours are HARD-CODED, never var(--event-*),
       and must stay that way: an event's branding must never be able to
       recolour "Agent mất kết nối" into something that reads as normal
       (08-UI-SPEC: fixed, non-configurable system-status roles). The config
       applier below cannot reach these — it writes an explicit allow-list of
       --event-* properties and nothing else. */
    .status{margin-top:auto;padding-top:2rem;color:var(--muted);font-size:var(--t-caption)}
    .online{color:#34d399}.offline{color:#a33127}
    /* D-07: the feed-disconnected banner. Same fixed destructive colour, same
       reason — a lost feed is an operational fault, not a branding surface. */
    #banner{position:fixed;top:0;left:0;right:0;z-index:9;display:none;background:#a33127;color:#fff;
      font-size:var(--t-label);font-weight:700;text-align:center;padding:.9rem 1rem}
    #banner.show{display:block}

    @keyframes pulse{0%{transform:scale(1.12);background:var(--accent);color:var(--paper)}100%{transform:scale(1)}}
    @media(max-width:900px){main{grid-template-columns:1fr;padding:2rem;gap:2rem}aside{border-left:0;border-top:1px solid var(--line);padding-left:0;padding-top:2rem}ol{max-height:32vh}}
  </style>
</head>
<body data-layout="${SHIPPED_LAYOUT_STYLE}">
<div id="banner" role="status">Mất kết nối — đang thử kết nối lại…</div>
<main>
  <section class="stage">
    <div class="eyebrow"><span class="dot"></span><span id="state">Sẵn sàng</span></div>
    <!-- UI-01: the idle/standby state is SERVER-RENDERED, in the first bytes
         the browser receives. It is not injected by the first snapshot and not
         preceded by a spinner, so the window between opening the page and the
         first WS message shows the standby screen rather than blank or
         unstyled markup (08-UI-SPEC's "initial WS connect" backstop). The
         copy here is the shipped default; an event's own copy replaces it on
         the first snapshot. -->
    <div class="hero" id="hero">
      <p class="idle" id="idleHeading">Sẵn sàng chụp ảnh cùng bạn</p>
      <p class="label" id="idleSub">Quét mã QR bên dưới để đăng ký</p>
    </div>
    <div class="meta" id="queueMeta">Chưa có khách trong hàng chờ</div>
  </section>
  <aside>
    <h2>Thứ tự tiếp theo</h2>
    <ol id="queue"></ol>
    <div class="status" id="agent"></div>
  </aside>
</main>
<script>
  var hero=document.querySelector('#hero'),queue=document.querySelector('#queue'),
      stateEl=document.querySelector('#state'),agentEl=document.querySelector('#agent'),
      meta=document.querySelector('#queueMeta'),banner=document.querySelector('#banner');
  var previousCount=null;

  // CMS-01: the config applier. Runs on EVERY snapshot rather than once at
  // load, which is what makes activating an event in the CMS re-theme every
  // connected screen live — no reload, no per-screen URL (D-12).
  //
  // The map below is an explicit allow-list of the five themeable colour
  // roles plus the font. It is not a loop over the snapshot's keys on
  // purpose: setProperty() with an attacker- or operator-supplied property
  // NAME would let a future config field write any custom property on the
  // document, including the ones holding the fixed operational colours.
  /* The three curated font choices, and EXACTLY three. The keys match
     FONT_CHOICES in the CMS (src/cms/cmsEventPages.ts), and the lookup below
     falls back to the system stack for any other value — so a stored value
     from a future schema change, a hand-edited database, or a rolled-back
     deploy can never leave the screen unstyled. Each stack keeps a system
     fallback behind the webfont for the same reason. */
  var FONTS={
    'system-ui':'system-ui,-apple-system,"Segoe UI",sans-serif',
    'be-vietnam-pro':'"Be Vietnam Pro",system-ui,-apple-system,sans-serif',
    'lora':'"Lora",Georgia,"Times New Roman",serif'
  };
  function applyEventConfig(cfg){
    if(!cfg)return;
    var root=document.documentElement.style;
    root.setProperty('--event-bg',cfg.colorDominant);
    root.setProperty('--event-surface',cfg.colorSecondary);
    root.setProperty('--event-accent',cfg.colorAccent);
    root.setProperty('--event-text',cfg.colorText);
    root.setProperty('--event-text-muted',cfg.colorTextMuted);
    root.setProperty('--event-font',FONTS[cfg.fontChoice]||FONTS['system-ui']);
  }

  // The incumbent web-slide's fallback, carried forward unchanged.
  function getInitials(name){
    return String(name||'').trim().split(/\\s+/).map(function(w){return w.charAt(0)}).join('').toUpperCase().slice(0,2);
  }

  /* Builds one photo tile. The URL is assigned to the img's src PROPERTY and
     the name to textContent — never interpolated into an innerHTML string.
     Both values crossed a trust boundary to get here (the Agent supplied the
     URL, an operator or guest the name), and this is the only place they meet
     the DOM (T-08-10). A load failure swaps in the neutral placeholder rather
     than leaving the browser's broken-image glyph on a wall. */
  function photoFrame(photo,badgeText){
    var frame=document.createElement('div');
    frame.className='frame';
    if(photo&&photo.photoUrl){
      var img=document.createElement('img');
      img.alt='';
      img.addEventListener('error',function(){
        frame.innerHTML='<div class="broken"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
          +'<path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
          +'<circle cx="12" cy="17.5" r="1.2" fill="currentColor"/>'
          +'<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
          +'</svg><span></span></div>';
        frame.querySelector('.broken span').textContent='Không tải được ảnh';
      });
      img.src=photo.photoUrl;
      frame.appendChild(img);
    }else{
      // Name-only tile: initials avatar, never a blank or broken frame.
      var avatar=document.createElement('div');
      avatar.className='avatar';
      avatar.textContent=getInitials(photo&&photo.name);
      frame.appendChild(avatar);
    }
    if(badgeText){
      var badge=document.createElement('div');
      badge.className='badge';
      badge.textContent=badgeText;
      frame.appendChild(badge);
    }
    return frame;
  }

  function shotTile(photo,badgeText,pipCount,pipIndex){
    var wrap=document.createElement('div');
    wrap.className='shot';
    wrap.appendChild(photoFrame(photo,badgeText));
    // D9-04: guestNameEnabled is read here, not passed in — this is called
    // from both render() (the hero tile) and drawSlide()'s own setInterval
    // callback (the slideshow tile), and the module-level flag is what keeps
    // both in step with the latest snapshot without threading a parameter
    // through the rotation timer.
    if(guestNameEnabled){
      var name=document.createElement('p');
      name.className='shotname';
      name.textContent=(photo&&photo.name)||'';
      wrap.appendChild(name);
    }
    // Zero-one-many: a single slide draws NO rotation indicator at all. Dots
    // on a one-photo slideshow promise a rotation that never comes.
    if(pipCount>1){
      var dots=document.createElement('div');
      dots.className='dots';
      for(var i=0;i<pipCount;i++){
        var pip=document.createElement('span');
        pip.className='pip'+(i===pipIndex?' on':'');
        dots.appendChild(pip);
      }
      wrap.appendChild(dots);
    }
    return wrap;
  }

  /* D-10/D-12 slideshow state. Everything it needs is re-read from the SNAPSHOT
     on every update — the photo list, photoCount and photoDurationMs — so an
     operator changing the per-photo duration or the photo count mid-event
     reaches every TV on the next snapshot with no reload. Nothing here is
     captured once at load. */
  var slides=[],slideIndex=0,slideTimer=null,slideKey='',slideDuration=6000;
  // D9-04: the two per-event toggles, re-derived on every render() call from
  // the snapshot's eventConfig (never captured once at load) and read by
  // shotTile()/drawSlide() outside render()'s own call stack — see the
  // comment on shotTile() above for why these live at module scope rather
  // than as parameters.
  var heroTakeoverEnabled=true,guestNameEnabled=true;
  function stopSlideshow(){ if(slideTimer){clearInterval(slideTimer);slideTimer=null} }
  function syncSlides(data){
    var cfg=data.eventConfig||{};
    var count=typeof cfg.photoCount==='number'?cfg.photoCount:12;
    var duration=typeof cfg.photoDurationMs==='number'&&cfg.photoDurationMs>0?cfg.photoDurationMs:6000;
    // Skip anything with no image: a no_photo guest is absent from the
    // slideshow entirely rather than appearing as an empty frame.
    var next=(data.photos||[]).filter(function(p){return p&&p.photoUrl}).slice(0,count);
    var key=next.map(function(p){return p.photoUrl}).join('|')+'@'+duration;
    if(key===slideKey)return;
    slideKey=key;slides=next;slideDuration=duration;
    if(slideIndex>=slides.length)slideIndex=0;
    stopSlideshow();
    if(slides.length>1){
      slideTimer=setInterval(function(){
        slideIndex=(slideIndex+1)%slides.length;
        if(currentStageState==='slideshow')drawSlide();
      },slideDuration);
    }
  }
  function drawSlide(){
    hero.innerHTML='';
    hero.appendChild(shotTile(slides[slideIndex],null,slides.length,slideIndex));
  }

  var currentStageState='idle';

  function renderIdle(cfg){
    // Written with textContent, never innerHTML — the heading and sub are
    // operator-authored strings, and interpolating them as markup would turn
    // the CMS config form into a stored-XSS path onto every TV.
    hero.innerHTML='<p class="idle" id="idleHeading"></p><p class="label" id="idleSub"></p>';
    hero.querySelector('#idleHeading').textContent=cfg.idleHeading||'Sẵn sàng chụp ảnh cùng bạn';
    hero.querySelector('#idleSub').textContent=cfg.qrCtaText||cfg.idleSub||'Quét mã QR bên dưới để đăng ký';
  }

  function render(data){
    applyEventConfig(data.eventConfig);
    var cfg=data.eventConfig||{};
    // D9-04: compared against the literal false explicitly, never tested for
    // truthiness — an absent field (a snapshot from a not-yet-restarted
    // server) must mean ON, so today's behaviour holds through a rolling
    // deploy rather than silently losing the hero moment or the guest name.
    heroTakeoverEnabled=cfg.heroEnabled!==false;
    guestNameEnabled=cfg.showGuestName!==false;
    syncSlides(data);

    stateEl.textContent=data.boothState==='ANNOUNCING'?'Chuẩn bị vào vị trí':data.boothState==='BUSY'?'Đang chụp':'Sẵn sàng';
    agentEl.className='status '+(data.agentOnline?'online':'offline');
    agentEl.textContent=data.agentOnline?'● Agent đang kết nối':'● Agent mất kết nối';
    meta.textContent=data.queueLength?data.queueLength+' khách đang chờ':'Chưa có khách trong hàng chờ';

    // Sidebar. Row names truncate with an ellipsis (see .qname) and carry the
    // full string in title=, so nothing is unrecoverable from a cut row.
    queue.innerHTML='';
    var upNext=data.upNext||[];
    if(!upNext.length){
      var none=document.createElement('li');
      none.className='qempty';
      none.textContent='Chưa có khách trong hàng chờ';
      queue.appendChild(none);
    }
    for(var i=0;i<upNext.length;i++){
      var li=document.createElement('li');
      li.className='guest';
      var pos=document.createElement('span');
      pos.className='pos';
      pos.textContent=String(upNext[i].position).padStart(2,'0');
      var nm=document.createElement('span');
      nm.className='qname';
      nm.textContent=upNext[i].name;
      nm.title=upNext[i].name;
      li.appendChild(pos);li.appendChild(nm);
      queue.appendChild(li);
    }

    // Stage precedence. justCaptured is checked FIRST and reads its name from
    // justCaptured, never from guestName: the guest who just finished shooting
    // and the guest being announced are two different people at this instant,
    // and showing the announced guest's name over the finished guest's photo
    // is the exact D-09 failure this ordering prevents.
    //
    // D9-04: the precedence ORDER is untouched — heroTakeoverEnabled only
    // gates whether this first branch is taken at all. With it false the
    // chain falls through to whichever branch would have run next; the just-
    // captured photo is still in data.photos (buildSnapshot() does not read
    // this flag), so it still reaches the slideshow branch below.
    if(heroTakeoverEnabled&&data.justCaptured){
      currentStageState='hero';
      hero.innerHTML='';
      hero.appendChild(shotTile(data.justCaptured,'Ảnh vừa chụp',1,0));
    }else if(data.boothState==='ANNOUNCING'&&data.guestName){
      currentStageState='announcing';
      hero.innerHTML='<p class="label">Xin mời khách tiếp theo</p><h1 id="guest"></h1>'
        +'<div class="callout"><div class="count" id="count"></div>'
        +'<p class="instruction">Chuẩn bị trước máy ảnh — phiên chụp sắp bắt đầu.</p></div>';
      hero.querySelector('#guest').textContent=data.guestName;
      var count=hero.querySelector('#count');
      count.textContent=data.countdownSeconds==null?'':data.countdownSeconds;
      if(previousCount!==data.countdownSeconds){count.classList.add('pulse');previousCount=data.countdownSeconds}
    }else if(data.boothState==='BUSY'){
      currentStageState='capturing';
      hero.innerHTML='<p class="idle">Đang chụp ảnh.<br>Hãy nhìn vào ống kính.</p>';
    }else if(slides.length>=1){
      currentStageState='slideshow';
      drawSlide();
    }else{
      // Zero photos, no guest, nothing announced: the deliberately drawn idle
      // state (UI-01), not an empty stage.
      currentStageState='idle';
      renderIdle(cfg);
    }
  }

  /* D-07. A closed socket shows a banner and LEAVES THE RENDERED STAGE ALONE.
     Nothing in this path clears the hero, resets the queue or falls back to
     idle: a guest watching their own photo during a three-second service
     restart must not see it wiped. The screen keeps its last known content and
     says, honestly, that it is reconnecting.

     The retry delay GROWS rather than hammering a fixed 1.5s forever — a
     service that is down for ten minutes should not be taking a request from
     every TV in the building four times a minute for all of it. */
  var RETRY_MIN_MS=1000,RETRY_MAX_MS=15000,retryDelay=RETRY_MIN_MS;
  function connect(){
    var protocol=location.protocol==='https:'?'wss':'ws';
    var ws=new WebSocket(protocol+'://'+location.host+'/display');
    ws.onopen=function(){
      retryDelay=RETRY_MIN_MS;
      banner.classList.remove('show');
    };
    ws.onmessage=function(e){
      banner.classList.remove('show');
      render(JSON.parse(e.data).data);
    };
    ws.onclose=function(){
      banner.classList.add('show');
      setTimeout(connect,retryDelay);
      retryDelay=Math.min(Math.round(retryDelay*1.7),RETRY_MAX_MS);
    };
    ws.onerror=function(){ws.close()};
  }
  connect();
</script>
</body></html>`;
}
