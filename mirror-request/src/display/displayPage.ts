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

/**
 * The screen's own name, shown large for a few seconds after load and then
 * reduced to a dim corner mark.
 *
 * Both room screens USED TO draw the same photos from the same snapshot, so
 * an operator setting up two TVs could not tell which URL a given screen was
 * on — the difference was a sidebar column, which reads as "this TV is just
 * cropped differently". The screens have since diverged properly (this one
 * shows no photographs at all), but the badge stays: it is what answers the
 * question on the first glance, before anyone waits for a state to change.
 * The timing is the whole
 * design: setup is when the question is asked, so the answer is unmissable
 * then and nearly invisible for the rest of the night. A permanent banner on
 * a wall screen at a wedding would be noise aimed at guests to solve an
 * operator's problem.
 *
 * Static text, never guest data — it is safe as markup precisely because
 * nothing request-supplied reaches it.
 */
export const SCREEN_BADGE_LABEL = 'Màn chờ chụp';
export const SCREEN_BADGE_HINT = 'Hàng chờ và lượt gọi — không có ảnh';
/** How long the badge stays at full size before shrinking to the corner. */
export const SCREEN_BADGE_PROMINENT_MS = 8000;

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

    /* No photo-tile styles. Every rule that dressed a photograph on this
       screen (.shot, .frame, .shotname, .badge, .dots, .pip, .broken,
       .avatar) went with the code that used them on 2026-08-14 — see the
       stage-precedence note below. slidesPage.ts carries its own. */

    /* CMS-07: the event's background image, and its logo.
       The background sits UNDER the paper colour's own scrim so operator text
       stays legible over any photograph — a bright wedding portrait behind
       white type is unreadable at TV distance (UI-01), and the operator
       choosing a background should not have to also solve contrast. */
    #eventBg{position:fixed;inset:0;z-index:-2;background-size:cover;background-position:center;background-repeat:no-repeat}
    #eventBg:after{content:"";position:absolute;inset:0;background:var(--paper);opacity:var(--event-bg-overlay,.72)}
    /* Top-RIGHT: the screen-identity badge owns the top-left corner. */
    #eventLogo{position:fixed;top:1.6vw;right:1.6vw;z-index:5;max-height:7vh;max-width:18vw;object-fit:contain;pointer-events:none}

    /* The QR block in the idle state: the code big enough to scan from a few
       metres, its caption directly beneath. */
    .qrblock{display:flex;flex-direction:column;align-items:flex-start;gap:1rem;margin:2.5rem 0 0}
    .qrblock img{width:clamp(9rem,16vw,16rem);aspect-ratio:1;object-fit:contain;background:#fff;padding:.75rem;border-radius:.75rem}
    .qrblock .label{margin:0;max-width:22ch}

    /* The screen-identity badge. Fixed so it never moves with content, and
       pointer-events:none so it can never intercept anything. It shrinks by
       transition rather than disappearing: a screen that can still be
       identified at a glance, all night, without competing with the photos. */
    .screenbadge{position:fixed;top:1.6vw;left:1.6vw;z-index:5;pointer-events:none;
      display:flex;flex-direction:column;gap:.2rem;
      background:color-mix(in srgb,var(--accent) 22%,var(--surface));
      color:var(--ink);border:1px solid var(--accent);border-radius:.6rem;
      padding:1rem 1.5rem;
      transition:opacity .8s ease,transform .8s ease,padding .8s ease;
      transform-origin:top left}
    .screenbadge b{font-size:clamp(1.4rem,2.4vw,2.6rem);font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:1}
    .screenbadge span{font-size:clamp(.8rem,1.1vw,1.1rem);color:var(--muted);letter-spacing:.06em}
    /* After the prominent window: small, dim, still legible up close. */
    .screenbadge.settled{opacity:.32;transform:scale(.5);padding:.6rem .9rem}
    /* An operator who wants it back can wake it from the CMS-free path:
       reloading the TV re-runs the prominent window. */

    aside{border-left:1px solid var(--line);padding-left:2.5rem;display:flex;flex-direction:column;min-height:0;
      /* CMS-06: the queue is this screen's REASON, not a margin note. A tinted
         panel with its own edge makes the two-region split readable across a
         room, which "a column to the right of a photo" was not. */
      background:color-mix(in srgb,var(--accent) 8%,transparent);
      border-radius:1rem;padding:2rem 2rem 2rem 2.5rem}
    /* margin is "0 0 2.5rem", not "0 0:2.5rem". The stray colon (pre-existing
       since Phase 5, logged as deferred item D-1 during 08-01) made the whole
       declaration invalid, so this heading silently had no bottom margin. */
    aside h2{font-size:var(--t-caption);font-weight:700;text-transform:uppercase;letter-spacing:.18em;margin:0 0 2.5rem}
    /* The count rides the heading rather than sitting in its own row: it is
       the fact this screen exists to publish, and the slides screen carries no
       queue metadata of any kind (D9-01), so this is content the two screens
       can never share. */
    .qcount{display:inline-block;margin-left:.6rem;padding:.15rem .6rem;border-radius:999px;
      background:var(--accent);color:var(--paper);letter-spacing:0}
    .qcount:empty{display:none}
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
<!-- CMS-07: the event background, behind everything. A separate fixed layer
     rather than a body background so the noise overlay, the badge and the
     disconnect banner all keep sitting on top of it, and so clearing the
     image in the CMS is one property reset rather than a repaint of body. -->
<div id="eventBg" hidden></div>
<img id="eventLogo" alt="" hidden>
<div id="banner" role="status">Mất kết nối — đang thử kết nối lại…</div>
<div class="screenbadge" id="screenbadge" aria-hidden="true"><b>${SCREEN_BADGE_LABEL}</b><span>${SCREEN_BADGE_HINT}</span></div>
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
    <h2>Thứ tự tiếp theo<span id="queueCount" class="qcount"></span></h2>
    <ol id="queue"></ol>
    <div class="status" id="agent"></div>
  </aside>
</main>
<script>
  /* The badge settles on a timer, not on the first snapshot: a screen that
     never receives one is exactly the screen whose identity an operator is
     trying to read. */
  setTimeout(function(){
    var badge=document.querySelector('#screenbadge');
    if(badge) badge.classList.add('settled');
  }, ${SCREEN_BADGE_PROMINENT_MS});

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
    applyEventImages(cfg);
  }

  /* CMS-07: the background and the logo.
     Until 2026-08-14 an operator could upload a logo, a background and a QR
     code, the files were stored, served and carried in the snapshot — and no
     screen read any of them. The CMS promised three things it did not do.

     The URL is assigned through the style property and the img src PROPERTY,
     never interpolated into an innerHTML string: it is operator-supplied and
     crosses a trust boundary to get here, the same rule the photo tiles used
     to follow. Absent values RESET rather than being skipped, so clearing an
     image in the CMS clears it on every TV at the next snapshot instead of
     leaving the old one until someone reloads. */
  function applyEventImages(cfg){
    /* CMS-10: the dim is the operator's number now, not a constant of ours.
       A heavy default kept white type legible over a bright photograph, and
       made a deliberately dark backdrop invisible — which is a judgement about
       the customer's own artwork that this code is in no position to make.
       Clamped here too: the projection clamps, and a page that trusts a number
       it was handed is a page one bad row away from an unreadable wall. */
    var ov=typeof cfg.backgroundOverlay==='number'?cfg.backgroundOverlay:72;
    ov=Math.min(100,Math.max(0,ov));
    document.documentElement.style.setProperty('--event-bg-overlay',String(ov/100));
    var bg=document.querySelector('#eventBg');
    if(bg){
      if(cfg.backgroundUrl){
        bg.style.backgroundImage='url("'+encodeURI(cfg.backgroundUrl)+'")';
        bg.hidden=false;
      }else{
        bg.style.backgroundImage='';
        bg.hidden=true;
      }
    }
    var logo=document.querySelector('#eventLogo');
    if(logo){
      if(cfg.logoUrl){
        logo.src=cfg.logoUrl;
        logo.hidden=false;
      }else{
        logo.removeAttribute('src');
        logo.hidden=true;
      }
    }
  }

  /* No photo tile builder, no slideshow, no hero moment.
     Everything that drew a photograph on this screen was removed on
     2026-08-14 when the operator decided the waiting screen answers "when is
     my turn" and nothing else; every photograph now lives on ?view=slides.
     That supersedes D-09's hero moment and D-10's rotation FOR THIS PAGE only
     — slidesPage.ts still draws both, off the same snapshot, and the snapshot
     itself is unchanged (D-12: one snapshot, every screen).

     The helpers are DELETED rather than left unused behind a flag: a photo
     renderer nothing calls is a photo renderer that comes back by accident,
     and the trust-boundary rules it carried (src property, textContent, never
     innerHTML for guest data) now live in exactly one place instead of two.

     Removed here: the photo-frame and photo-tile builders, the initials
     fallback, the slideshow sync/draw/stop trio, and the two D9-04 toggle
     flags they were read through. (Deliberately described rather than named:
     a test asserts those identifiers no longer appear in this document, and
     a comment listing them would be the only thing keeping them there.)
     'heroEnabled' and 'showGuestName' remain live event settings — they now
     govern the slides view alone, and the CMS copy was corrected to say so. */

  var currentStageState='idle';

  function renderIdle(cfg){
    // Written with textContent, never innerHTML — the heading and sub are
    // operator-authored strings, and interpolating them as markup would turn
    // the CMS config form into a stored-XSS path onto every TV.
    //
    // CMS-07: the QR lives HERE and only here. Idle is now this screen's
    // resting state (the slideshow that used to fill it is gone), so this is
    // what a room full of people who have not registered yet actually looks
    // at — which is precisely the moment a registration QR is useful. It is
    // deliberately absent from the announcing and capturing states: a guest
    // being called to the camera does not need to scan anything, and a code
    // on screen during someone's turn is clutter aimed at the wrong person.
    hero.innerHTML='<p class="idle" id="idleHeading"></p>'
      +'<div class="qrblock" id="qrBlock" hidden><img id="qrImage" alt=""><p class="label" id="qrCta"></p></div>'
      +'<p class="label" id="idleSub"></p>';
    hero.querySelector('#idleHeading').textContent=cfg.idleHeading||'Sẵn sàng chụp ảnh cùng bạn';

    var qrBlock=hero.querySelector('#qrBlock');
    var cta=cfg.qrCtaText||cfg.idleSub||'Quét mã QR bên dưới để đăng ký';
    if(cfg.qrImageUrl){
      // src PROPERTY, and the caption as textContent — both crossed a trust
      // boundary to reach this screen.
      hero.querySelector('#qrImage').src=cfg.qrImageUrl;
      hero.querySelector('#qrCta').textContent=cta;
      qrBlock.hidden=false;
      // The call to action rides the QR block; showing it twice would read as
      // two different instructions.
      hero.querySelector('#idleSub').textContent='';
    }else{
      // No QR uploaded: the old behaviour exactly — the instruction alone.
      hero.querySelector('#idleSub').textContent=cta;
    }
  }

  function render(data){
    applyEventConfig(data.eventConfig);
    var cfg=data.eventConfig||{};
    // D9-04: compared against the literal false explicitly, never tested for
    // truthiness — an absent field (a snapshot from a not-yet-restarted
    // server) must mean ON, so today's behaviour holds through a rolling
    // deploy rather than silently losing the hero moment or the guest name.

    stateEl.textContent=data.boothState==='ANNOUNCING'?'Chuẩn bị vào vị trí':data.boothState==='BUSY'?'Đang chụp':'Sẵn sàng';
    agentEl.className='status '+(data.agentOnline?'online':'offline');
    agentEl.textContent=data.agentOnline?'● Agent đang kết nối':'● Agent mất kết nối';
    meta.textContent=data.queueLength?data.queueLength+' khách đang chờ':'Chưa có khách trong hàng chờ';
    /* textContent, and empty rather than "0" when nobody is waiting — the
       :empty rule hides the pill entirely, so an idle screen shows no badge
       instead of a zero the room has to interpret. */
    var qc=document.querySelector('#queueCount');
    if(qc) qc.textContent=data.queueLength?String(data.queueLength):'';

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

    // Stage precedence — THIS SCREEN SHOWS NO PHOTOGRAPHS AT ALL.
    //
    // D-09 gave this screen a hero moment for the guest who had just finished
    // ("their new photo fills the screen with their name for ~10-15 seconds,
    // then joins the rotating slideshow"), and D-10 gave it that rotation.
    // Both were decided in Phase 8, when this was the ONLY room screen.
    // Phase 9 added the slides-only view and never revisited them, so for a
    // while both screens ran the same slideshow off the same snapshot — which
    // is what an operator saw and reported: "màn hình chờ chụp sao vẫn có ảnh
    // của người cũ".
    //
    // The operator's answer, on 2026-08-14, was to take photographs off this
    // screen entirely — hero moment included. That SUPERSEDES D-09 for this
    // page: the waiting screen answers "when is my turn" and nothing else,
    // and every photograph lives on ?view=slides. 'justCaptured' and 'photos'
    // are still in the snapshot (the slides view needs both, and D-12 keeps
    // one snapshot for every screen); this page simply draws neither.
    //
    // The chain is now announcing -> capturing -> idle, and idle is where a
    // screen with nothing to announce comes to rest — the QR and the call to
    // register, which is the useful thing to show a room full of people who
    // have not signed up yet.
    if(data.boothState==='ANNOUNCING'&&data.guestName){
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
    }else{
      // Nothing announced and nobody shooting: the deliberately drawn idle
      // state (UI-01), not an empty stage. This is now the resting state of
      // the screen rather than a zero-photo edge case, which is why the QR and
      // its call to register matter more than they used to.
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
