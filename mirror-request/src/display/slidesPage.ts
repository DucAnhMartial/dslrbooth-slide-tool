/**
 * The slides-only room screen (D9-01, SC-1): `/display-screen?view=slides`.
 * The photo surface alone, at full width, with no queue column and no queue
 * metadata of any kind. Every TV still renders the same active event and the
 * same snapshot as the default screen (D-12 is untouched) — this file draws
 * fewer REGIONS of it, nothing more.
 *
 * This is a STANDALONE template-string module, deliberately NOT a refactor of
 * displayPage.ts into shared partials. 09-CONTEXT.md leaves that choice open
 * and asks for whatever keeps D9-02 (the bare route renders exactly what it
 * rendered before this phase) trivially true to believe, and the cheapest way
 * to guarantee the live page is unchanged is to not restructure it. The
 * duplication below — fonts, theme variables, tile construction, reconnect
 * logic — is deliberate, not an oversight. Plan 09-02 adds a cross-page test
 * pinning the invariants the two pages must agree on.
 *
 * ZERO BUILD STEP, ZERO NETWORK AT RENDER TIME — same discipline as
 * displayPage.ts. No CDN, no Google Fonts link, no remote stylesheet.
 *
 * A note for anyone editing this file: it is one template literal, so a
 * BACKTICK anywhere inside it — including inside a comment — terminates the
 * string and breaks the build. Quote identifiers with 'single quotes' in
 * comments here, not backticks.
 */

export function renderSlidesPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Booth Slides</title>
  <style>
    /* The same two self-hosted families as the default screen, same reasons
       (T-08-SC): no font CDN, weights 400/700 only, full-coverage builds so a
       diacritic never falls back to a different face mid-name. */
    @font-face{font-family:"Be Vietnam Pro";font-style:normal;font-weight:400;font-display:swap;
      src:url("/assets/fonts/be-vietnam-pro-400.woff2") format("woff2")}
    @font-face{font-family:"Be Vietnam Pro";font-style:normal;font-weight:700;font-display:swap;
      src:url("/assets/fonts/be-vietnam-pro-700.woff2") format("woff2")}
    @font-face{font-family:"Lora";font-style:normal;font-weight:400;font-display:swap;
      src:url("/assets/fonts/lora-400.woff2") format("woff2")}
    @font-face{font-family:"Lora";font-style:normal;font-weight:700;font-display:swap;
      src:url("/assets/fonts/lora-700.woff2") format("woff2")}

    /* Same --event-* allow-list and shipped defaults as the default screen
       (CMS-01, UI-01): correct on first paint, before any WS snapshot. */
    :root{
      --event-bg:#0a0a0f;--event-surface:#13131a;--event-accent:#6c8fff;
      --event-text:#f5f5f7;--event-text-muted:#9a9aa8;
      --event-font:system-ui,-apple-system,"Segoe UI",sans-serif;
      --ink:var(--event-text);--paper:var(--event-bg);--accent:var(--event-accent);
      --surface:var(--event-surface);--muted:var(--event-text-muted);
      --line:rgba(245,245,247,.16);
      --t-caption:clamp(.75rem,1vw,1rem);
      --t-label:clamp(1rem,1.6vw,1.5rem);
      --t-heading:clamp(1.25rem,2vw,1.8rem);
      --t-display:clamp(2.5rem,8vw,8rem)
    }
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow:hidden}
    body{background:var(--paper);color:var(--ink);font-family:var(--event-font);font-weight:400;line-height:1.4}
    body:after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.25'/%3E%3C/svg%3E")}

    /* SC-1: one full-width column. No sidebar, no second grid track — the
       photo surface reclaims the whole viewport (UI-01: this is a design
       task, not display:none on an aside that never existed here). */
    main{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr);padding:4.5vw}
    .stage{display:flex;flex-direction:column;justify-content:center;min-width:0;min-height:0}

    .label{font-size:var(--t-label);color:var(--muted);margin:0 0 1rem}
    .idle{font-size:var(--t-display);font-weight:700;max-width:13ch;line-height:1.05;margin:0;overflow-wrap:anywhere}

    /* D-09 hero moment, and D-10 slideshow: the same tile, exactly as on the
       default screen — the same photo seen at different ages. */
    .shot{display:flex;flex-direction:column;gap:1.5rem;min-height:0;flex:1}
    .frame{flex:1;min-height:0;display:grid;place-items:center;background:var(--surface);border-radius:.75rem;overflow:hidden;position:relative}
    .frame img{max-width:100%;max-height:100%;object-fit:contain}
    .shotname{font-size:var(--t-display);font-weight:700;line-height:1.05;margin:0;max-width:16ch;overflow-wrap:anywhere}
    .badge{position:absolute;top:1rem;left:1rem;background:var(--accent);color:var(--paper);font-size:var(--t-caption);font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.35rem 1rem;border-radius:2rem}
    .dots{display:flex;gap:.5rem;justify-content:center;padding-top:1rem}
    .pip{width:.5rem;height:.5rem;border-radius:50%;background:var(--line)}
    .pip.on{width:1.6rem;border-radius:.25rem;background:var(--ink)}

    /* Same neutral broken-image fallback and initials avatar as the default
       screen, same reasons — never the browser's broken-image glyph. */
    .broken{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;width:100%;height:100%;color:var(--muted)}
    .broken svg{opacity:.35}
    .broken span{font-size:var(--t-label)}
    .avatar{width:clamp(5rem,9vw,8rem);aspect-ratio:1;border-radius:50%;background:var(--accent);color:var(--paper);display:grid;place-items:center;font-size:clamp(2rem,4vw,3.5rem);font-weight:700}

    /* D-07: same fixed destructive colour, same reason — a lost feed is an
       operational fault, never a branding surface. */
    #banner{position:fixed;top:0;left:0;right:0;z-index:9;display:none;background:#a33127;color:#fff;
      font-size:var(--t-label);font-weight:700;text-align:center;padding:.9rem 1rem}
    #banner.show{display:block}
  </style>
</head>
<body data-view="slides">
<div id="banner" role="status">Mất kết nối — đang thử kết nối lại…</div>
<main>
  <section class="stage" id="stage">
    <!-- UI-01: server-rendered idle backstop, in the first bytes the browser
         receives — not injected by the first snapshot, not preceded by a
         spinner. Shipped-default copy; an event's own CTA replaces it on the
         first snapshot. -->
    <div class="hero" id="hero">
      <p class="idle" id="idleHeading">Sẵn sàng chụp ảnh cùng bạn</p>
      <p class="label" id="idleSub">Quét mã QR bên dưới để đăng ký</p>
    </div>
  </section>
</main>
<script>
  var hero=document.querySelector('#hero'),banner=document.querySelector('#banner');

  // CMS-01: same explicit five-colour-role-plus-font allow-list as the
  // default screen's applier, run on every snapshot rather than once at load
  // (D-12). Not a loop over the snapshot's keys — see displayPage.ts's
  // comment on why that would be a hazard.
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

  function getInitials(name){
    return String(name||'').trim().split(/\\s+/).map(function(w){return w.charAt(0)}).join('').toUpperCase().slice(0,2);
  }

  /* Same trust-boundary discipline as displayPage.ts: the URL is assigned to
     the img's src PROPERTY and the name to textContent — never interpolated
     into an innerHTML string (T-08-10/T-09-03). */
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
    // Zero-one-many: a single slide draws NO rotation indicator at all.
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

  /* D-10/D-12 slideshow state, re-read from the SNAPSHOT on every update —
     nothing here is captured once at load. Identical to displayPage.ts. */
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
    hero.innerHTML='<p class="idle" id="idleHeading"></p><p class="label" id="idleSub"></p>';
    hero.querySelector('#idleHeading').textContent=cfg.idleHeading||'Sẵn sàng chụp ảnh cùng bạn';
    hero.querySelector('#idleSub').textContent=cfg.qrCtaText||cfg.idleSub||'Quét mã QR bên dưới để đăng ký';
  }

  /* SC-1/D9-03: exactly THREE stage states — just-captured, slideshow, idle.
     This view carries no queue, so there is no announcing branch and no
     capturing branch here, unlike the default screen's five-state chain; the
     snapshot's queue-position list and its announced-guest name field are
     never read anywhere in this file. */
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

    // D9-04: heroTakeoverEnabled only gates whether this first branch is
    // taken; with it false the chain falls through to the slideshow branch
    // below, and the just-captured photo is still in data.photos
    // (buildSnapshot() does not read this flag), so it still joins rotation.
    if(heroTakeoverEnabled&&data.justCaptured){
      currentStageState='hero';
      hero.innerHTML='';
      hero.appendChild(shotTile(data.justCaptured,'Ảnh vừa chụp',1,0));
    }else if(slides.length>=1){
      currentStageState='slideshow';
      drawSlide();
    }else{
      currentStageState='idle';
      renderIdle(cfg);
    }
  }

  /* D-07: identical reconnect discipline to the default screen — a closed
     socket shows a banner and LEAVES THE RENDERED STAGE ALONE, and the retry
     delay GROWS rather than hammering a fixed interval forever. */
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
