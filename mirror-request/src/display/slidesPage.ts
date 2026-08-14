/**
 * The slides-only room screen (D9-01, SC-1): `/display-screen?view=slides`.
 * The photo surface alone, with no queue column and no queue metadata of any
 * kind. Every TV still renders the same active event and the same snapshot as
 * the default screen (D-12 is untouched) — this file draws fewer REGIONS of
 * it, nothing more.
 *
 * THE DESIGN IS web-slide's SLIDESHOW STAGE, on purpose. The operator walked
 * this view through three passes at the 09-02 human gate (2026-08-13): the
 * first full-bleed cut was "too big", the bounded card that replaced it was
 * still not it, and the third answer named the reference exactly — "ở phase
 * trước (tách extension và webhook còn chạy riêng) thì UI slide đó đẹp hơn".
 * That is the retired web-slide app, whose source D-08 kept in git AS LAYOUT
 * REFERENCE for precisely this moment. What made it read well, ported here:
 * photos on a pure black stage, a 0.6s opacity CROSS-FADE between slides
 * (the first two passes swapped innerHTML instantly, which is most of why
 * they felt cheap), the guest's name small and bold over a bottom gradient
 * rather than at display size, an accent "MỚI"-style pill for the fresh
 * capture, and the white dot rail floating over the photo.
 *
 * What is deliberately NOT ported from web-slide: phone/email/note in the
 * overlay (PII on a wall — the snapshot's photos[] carries {photoUrl, name}
 * only, and that stays the whole wire contract), the header/sidebar chrome,
 * the clear-all button, and its innerHTML interpolation of guest data (every
 * guest-controlled string here goes through textContent / the src property,
 * T-08-10/T-09-03).
 *
 * This is a STANDALONE template-string module, deliberately NOT a refactor of
 * displayPage.ts into shared partials — the cheapest way to keep D9-02 (the
 * bare route renders exactly what it rendered before this phase) trivially
 * true is to not restructure the live page. The cross-page invariants the two
 * files must agree on (fonts, applier allow-list, banner copy, backoff) are
 * pinned by test.
 *
 * ZERO BUILD STEP, ZERO NETWORK AT RENDER TIME — no CDN, no Google Fonts
 * link, no remote stylesheet.
 *
 * A note for anyone editing this file: it is one template literal, so a
 * BACKTICK anywhere inside it — including inside a comment — terminates the
 * string and breaks the build. Quote identifiers with 'single quotes' in
 * comments here, not backticks.
 */

/**
 * This screen's own name, the counterpart to displayPage's badge. Both room
 * screens draw the same photos from the same snapshot, so without these an
 * operator setting up two TVs cannot tell which URL each one is on — see
 * displayPage.ts's SCREEN_BADGE_LABEL for the full reasoning and the timing.
 *
 * Kept as separate constants per file rather than shared: a test asserts they
 * DIFFER, and a shared module would make that assertion about itself.
 */
export const SLIDES_BADGE_LABEL = 'Màn trình chiếu';
export const SLIDES_BADGE_HINT = 'Chỉ ảnh, không hàng chờ';
export const SLIDES_BADGE_PROMINENT_MS = 8000;

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
       (CMS-01, UI-01): correct on first paint, before any WS snapshot. The
       defaults are web-slide's own palette — Phase 8 adopted it wholesale,
       which is why an unconfigured event already looks like the reference. */
    :root{
      --event-bg:#0a0a0f;--event-surface:#13131a;--event-accent:#6c8fff;
      --event-text:#f5f5f7;--event-text-muted:#9a9aa8;
      --event-font:system-ui,-apple-system,"Segoe UI",sans-serif;
      --ink:var(--event-text);--paper:var(--event-bg);--accent:var(--event-accent);
      --surface:var(--event-surface);--muted:var(--event-text-muted);
      --line:rgba(245,245,247,.16);
      --t-caption:clamp(.7rem,.9vw,.95rem);
      --t-label:clamp(1rem,1.5vw,1.4rem);
      --t-display:clamp(2.25rem,6vw,6rem)
    }
    *{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
    body{background:var(--paper);color:var(--ink);font-family:var(--event-font);font-weight:400;line-height:1.4}

    /* web-slide's stage: pure black, edge to edge. Black is FIXED, not
       var(--event-bg) — a photo wall reads best on black regardless of the
       event's branding, and the reference hard-coded exactly this. The
       event's theme still owns the idle copy colours and the badge accent. */
    .stage{position:fixed;inset:0;overflow:hidden;background:#000}

    /* The cross-fade. Slides are stacked absolute layers; showing one is an
       opacity transition, never an innerHTML swap — this is the single
       biggest piece of what made the reference feel finished. */
    .slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      opacity:0;transition:opacity .6s ease;pointer-events:none}
    .slide.active{opacity:1}
    .slide img{max-width:100%;max-height:100%;object-fit:contain}

    /* web-slide's bottom overlay: name small and bold over a gradient, fixed
       white on fixed black-fade — legibility over an arbitrary photo cannot
       depend on the event's own theme choices. */
    .slide-overlay{position:absolute;bottom:0;left:0;right:0;padding:2rem 1.75rem 1.5rem;
      background:linear-gradient(to top,rgba(0,0,0,.85),transparent);pointer-events:none}
    .shotname{font-size:clamp(1.25rem,2vw,2.25rem);font-weight:700;letter-spacing:-.02em;
      margin:0;max-width:24ch;overflow-wrap:anywhere;color:#fff}

    /* The fresh-capture pill, in the event's accent — web-slide's MỚI badge,
       carrying this screen's own copy. */
    .new-badge{position:absolute;top:1rem;left:1rem;background:var(--accent);color:#fff;
      font-size:var(--t-caption);font-weight:700;letter-spacing:.06em;text-transform:uppercase;
      padding:.35rem 1rem;border-radius:2rem;animation:slideIn .4s ease}
    @keyframes slideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}

    /* web-slide's dot rail: floating over the photo near the bottom, white
       pill for the active slide. Sits ABOVE the layers so it never fades. */
    #dots{position:absolute;bottom:5.5rem;left:50%;transform:translateX(-50%);
      display:flex;gap:.5rem;align-items:center;z-index:3}
    .pip{width:.4rem;height:.4rem;border-radius:50%;background:rgba(255,255,255,.25);transition:all .2s}
    .pip.on{width:1.25rem;border-radius:.2rem;background:#fff}

    /* UI-01: the idle composition, centred on the stage, in the event's own
       colours — the one state where the theme paints the surface itself. */
    .idle-compose{flex-direction:column;text-align:center;gap:.75rem;background:var(--paper)}
    .idle{font-size:var(--t-display);font-weight:700;max-width:13ch;line-height:1.05;margin:0;overflow-wrap:anywhere}
    .label{font-size:var(--t-label);color:var(--muted);margin:0}

    /* Same neutral broken-image fallback and initials avatar as the default
       screen — never the browser's broken-image glyph. The avatar keeps
       web-slide's two-tone gradient. */
    .broken{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;width:100%;height:100%;color:var(--muted)}
    .broken svg{opacity:.35}
    .broken span{font-size:var(--t-label)}
    .avatar{width:clamp(6rem,10vw,9rem);aspect-ratio:1;border-radius:50%;
      background:linear-gradient(135deg,var(--accent),#a78bfa);color:#fff;
      display:grid;place-items:center;font-size:clamp(2.25rem,4vw,3.5rem);font-weight:700}

    /* D-07: same fixed destructive colour, same reason — a lost feed is an
       operational fault, never a branding surface. */
    #banner{position:fixed;top:0;left:0;right:0;z-index:9;display:none;background:#a33127;color:#fff;
      font-size:var(--t-label);font-weight:700;text-align:center;padding:.9rem 1rem}
    #banner.show{display:block}

    /* Screen identity. Same shape and timing as the queue screen's badge, and
       deliberately the same corner: an operator comparing two TVs reads the
       same spot on both. Muted rather than accent-tinted here — this stage is
       a black field with photographs on it, and a coloured block on it would
       be the brightest thing in the room. */
    .screenbadge{position:fixed;top:1.6vw;left:1.6vw;z-index:5;pointer-events:none;
      display:flex;flex-direction:column;gap:.2rem;
      background:rgba(255,255,255,.1);color:#fff;
      border:1px solid rgba(255,255,255,.35);border-radius:.6rem;
      padding:1rem 1.5rem;
      transition:opacity .8s ease,transform .8s ease,padding .8s ease;
      transform-origin:top left}
    .screenbadge b{font-size:clamp(1.4rem,2.4vw,2.6rem);font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:1}
    .screenbadge span{font-size:clamp(.8rem,1.1vw,1.1rem);color:rgba(255,255,255,.65);letter-spacing:.06em}
    .screenbadge.settled{opacity:.28;transform:scale(.5);padding:.6rem .9rem}

    /* T-09-13: the Agent-offline signal, rendered ONLY on the fault. Fixed
       destructive colour, unreachable from applyEventConfig() below. */
    #agentOffline{position:fixed;bottom:1.5rem;right:1.5rem;z-index:8;
      background:rgba(10,10,15,.72);color:#a33127;font-size:var(--t-caption);
      font-weight:700;letter-spacing:.04em;padding:.5rem 1.1rem;border-radius:2rem}
  </style>
</head>
<body data-view="slides">
<div id="banner" role="status">Mất kết nối — đang thử kết nối lại…</div>
<div class="screenbadge" id="screenbadge" aria-hidden="true"><b>${SLIDES_BADGE_LABEL}</b><span>${SLIDES_BADGE_HINT}</span></div>
<div id="agentOffline" role="status" hidden>● Agent mất kết nối</div>
<div class="stage" id="stage">
  <!-- UI-01: server-rendered idle backstop, in the first bytes the browser
       receives — a .slide layer already active, so the first real photo
       cross-fades OVER it instead of appearing after a blank. Shipped-default
       copy; an event's own CTA replaces it on the first snapshot. -->
  <div class="slide active idle-compose" id="hero">
    <p class="idle" id="idleHeading">Sẵn sàng chụp ảnh cùng bạn</p>
    <p class="label" id="idleSub">Quét mã QR bên dưới để đăng ký</p>
  </div>
  <div id="dots"></div>
</div>
<script>
  /* Settles on a timer, not on the first snapshot — a screen that never
     receives one is exactly the screen whose identity is being looked for. */
  setTimeout(function(){
    var badge=document.querySelector('#screenbadge');
    if(badge) badge.classList.add('settled');
  }, ${SLIDES_BADGE_PROMINENT_MS});

  var stage=document.querySelector('#stage'),dots=document.querySelector('#dots'),
      banner=document.querySelector('#banner'),agentOffline=document.querySelector('#agentOffline'),
      hero=document.querySelector('#hero');

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

  /* Builds one stacked .slide layer — web-slide's slide, minus its PII row
     and minus its innerHTML interpolation. Same trust-boundary discipline as
     displayPage.ts: the URL is assigned to the img's src PROPERTY and the
     name to textContent — never interpolated into markup (T-08-10/T-09-03). */
  function shotTile(photo,badgeText){
    var slide=document.createElement('div');
    slide.className='slide';
    if(photo&&photo.photoUrl){
      var img=document.createElement('img');
      img.alt='';
      img.addEventListener('error',function(){
        slide.innerHTML='<div class="broken"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
          +'<path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
          +'<circle cx="12" cy="17.5" r="1.2" fill="currentColor"/>'
          +'<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
          +'</svg><span></span></div>';
        slide.querySelector('.broken span').textContent='Không tải được ảnh';
      });
      img.src=photo.photoUrl;
      slide.appendChild(img);
    }else{
      var avatar=document.createElement('div');
      avatar.className='avatar';
      avatar.textContent=getInitials(photo&&photo.name);
      slide.appendChild(avatar);
    }
    // D9-04: guestNameEnabled is read here, not passed in — this is called
    // from both render() (the hero layer) and drawSlide()'s own setInterval
    // callback (the rotation layer), and the module-level flag is what keeps
    // both in step with the latest snapshot. The name rides web-slide's
    // bottom-gradient overlay, small and bold, never at display size.
    if(guestNameEnabled){
      var overlay=document.createElement('div');
      overlay.className='slide-overlay';
      var name=document.createElement('p');
      name.className='shotname';
      name.textContent=(photo&&photo.name)||'';
      overlay.appendChild(name);
      slide.appendChild(overlay);
    }
    if(badgeText){
      var badge=document.createElement('div');
      badge.className='new-badge';
      badge.textContent=badgeText;
      slide.appendChild(badge);
    }
    return slide;
  }

  /* The cross-fade swap. The new layer is appended invisible, faded in on
     the next frame, and the outgoing layer is removed only after the
     transition has finished — so there is never a black gap between photos,
     which is the property the reference design owes its polish to. */
  var currentLayer=hero,currentKey='idle';
  function showLayer(key,build){
    if(key===currentKey)return;
    currentKey=key;
    var next=build();
    stage.insertBefore(next,dots);
    var previous=currentLayer;
    currentLayer=next;
    requestAnimationFrame(function(){requestAnimationFrame(function(){
      next.classList.add('active');
      if(previous)previous.classList.remove('active');
    })});
    if(previous){setTimeout(function(){if(previous.parentNode)previous.parentNode.removeChild(previous)},700)}
  }

  function drawDots(count,index){
    dots.innerHTML='';
    // Zero-one-many: a single slide draws NO rotation indicator at all.
    if(count<2)return;
    for(var i=0;i<count;i++){
      var pip=document.createElement('span');
      pip.className='pip'+(i===index?' on':'');
      dots.appendChild(pip);
    }
  }

  /* D-10/D-12 slideshow state, re-read from the SNAPSHOT on every update —
     nothing here is captured once at load. Identical to displayPage.ts. */
  var slides=[],slideIndex=0,slideTimer=null,slideKey='',slideDuration=6000;
  // D9-04: the two per-event toggles, re-derived on every render() call from
  // the snapshot's eventConfig (never captured once at load) and read by
  // shotTile()/drawSlide() outside render()'s own call stack.
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
    var photo=slides[slideIndex];
    showLayer('slide|'+slideIndex+'|'+(photo&&photo.photoUrl),function(){return shotTile(photo,null)});
    drawDots(slides.length,slideIndex);
  }

  var currentStageState='idle';

  function renderIdle(cfg){
    showLayer('idle',function(){
      var layer=document.createElement('div');
      layer.className='slide idle-compose';
      var heading=document.createElement('p');heading.className='idle';
      heading.textContent=cfg.idleHeading||'Sẵn sàng chụp ảnh cùng bạn';
      var sub=document.createElement('p');sub.className='label';
      sub.textContent=cfg.qrCtaText||cfg.idleSub||'Quét mã QR bên dưới để đăng ký';
      layer.appendChild(heading);layer.appendChild(sub);
      return layer;
    });
    drawDots(0,0);
  }

  /* SC-1/D9-03: exactly THREE stage states — just-captured, slideshow, idle.
     This view carries no queue, so there is no announcing branch and no
     capturing branch here; the snapshot's queue-position list and its
     announced-guest name field are never read anywhere in this file. */
  function render(data){
    applyEventConfig(data.eventConfig);
    var cfg=data.eventConfig||{};
    // D9-04: compared against the literal false explicitly, never tested for
    // truthiness — an absent field (a snapshot from a not-yet-restarted
    // server) must mean ON, so today's behaviour holds through a rolling
    // deploy rather than silently losing the hero moment or the guest name.
    heroTakeoverEnabled=cfg.heroEnabled!==false;
    guestNameEnabled=cfg.showGuestName!==false;
    // T-09-13: the fault-only Agent signal, re-derived every snapshot.
    agentOffline.hidden=data.agentOnline!==false;
    syncSlides(data);

    // D9-04: heroTakeoverEnabled only gates whether this first branch is
    // taken; with it false the chain falls through to the slideshow branch
    // below, and the just-captured photo is still in data.photos
    // (buildSnapshot() does not read this flag), so it still joins rotation.
    if(heroTakeoverEnabled&&data.justCaptured){
      currentStageState='hero';
      showLayer('hero|'+data.justCaptured.photoUrl,function(){return shotTile(data.justCaptured,'Ảnh vừa chụp')});
      drawDots(0,0);
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
