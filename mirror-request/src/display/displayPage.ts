export function renderDisplayPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Booth Queue</title>
  <style>
    :root{--ink:#171713;--paper:#f3ead8;--accent:#ff5b3d;--muted:#8d8678;--line:rgba(23,23,19,.16)}
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow:hidden}
    body{background:var(--paper);color:var(--ink);font-family:"Avenir Next","Segoe UI",sans-serif}
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
    .status{margin-top:auto;padding-top:2rem;color:var(--muted);font-size:.9rem}.online{color:#34744b}.offline{color:#a33127}
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
  function render(data){
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
    else hero.innerHTML='<p class="idle">Vui lòng chờ lượt chụp tiếp theo.</p>';
  }
  function connect(){const protocol=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(protocol+'://'+location.host+'/display');ws.onmessage=e=>render(JSON.parse(e.data).data);ws.onclose=()=>setTimeout(connect,1500);ws.onerror=()=>ws.close()};connect();
</script>
</body></html>`;
}
