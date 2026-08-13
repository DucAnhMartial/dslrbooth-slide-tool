import express, { Request, Response, NextFunction } from 'express'
import { Logger, createLogger } from '../logging/logger'
import { Config } from '../config'

interface TriggerServerConfig {
  port: number
  onEvent: (eventType: string, params: Record<string, string>) => void
}

/**
 * `upNext` is still received and still stored, and NOTHING draws it.
 *
 * The booth kiosk page below used to carry a "Thứ tự tiếp theo" column beside
 * the countdown. Since Phase 8 the room screen at the service's
 * `/display-screen` carries the queue for the whole venue, so the column was
 * the one part of this page duplicating it — and two places rendering one list
 * is two places to disagree the moment either lags.
 *
 * The FIELD stays because dropping it would be a protocol change to a message
 * the service already sends (`announcement` carries `upNext`), which is a
 * different decision from not drawing it. `test/display-page-no-queue.test.ts`
 * pins both halves: the column is gone, and /display-state still reports what
 * arrives.
 */
export interface AgentDisplayState {
  phase: 'idle' | 'announcing' | 'busy'
  guestName: string | null
  endsAt: number | null
  queueLength: number
  upNext: Array<{ jobId: string; name: string; position: number }>
}

const displayPage = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Khách tiếp theo</title><style>
:root{--ink:#171713;--paper:#f3ead8;--accent:#ff5b3d;--muted:#8d8678;--line:rgba(23,23,19,.16)}*{box-sizing:border-box}html,body{margin:0;min-height:100%;overflow:hidden}body{background:var(--paper);color:var(--ink);font-family:"Avenir Next","Segoe UI",sans-serif}main{min-height:100vh;display:grid;grid-template-columns:1fr;padding:4.5vw;gap:5vw}.stage{display:flex;flex-direction:column;justify-content:space-between}.eyebrow{text-transform:uppercase;letter-spacing:.2em;font-weight:800}.hero{padding:4vh 0}.label{color:var(--muted);font-size:1.4rem}h1,.idle{font-family:Didot,"Bodoni 72",Georgia,serif;font-weight:500}.idle{font-size:clamp(3rem,7vw,7rem);line-height:1}h1{font-size:clamp(5rem,11vw,11rem);line-height:.86;letter-spacing:-.06em;margin:.2em 0;overflow-wrap:anywhere}.callout{display:flex;align-items:center;gap:2rem}.count{display:grid;place-items:center;width:8rem;aspect-ratio:1;border:3px solid;border-radius:50%;font-family:Didot,Georgia,serif;font-size:5rem}.pulse{animation:pulse .75s ease-out}.instruction{font-size:1.6rem;max-width:18ch}@keyframes pulse{0%{transform:scale(1.12);background:var(--accent);color:var(--paper)}100%{transform:scale(1)}}@media(max-width:800px){main{padding:2rem}}
</style></head><body><main><section class="stage"><div class="eyebrow" id="state">Agent đang chạy</div><div class="hero" id="hero"></div><div id="meta"></div></section></main><script>
const hero=document.querySelector('#hero'),state=document.querySelector('#state'),meta=document.querySelector('#meta');let previous=null;function draw(d){const seconds=d.endsAt?Math.max(0,Math.ceil((d.endsAt-Date.now())/1000)):null;state.textContent=d.phase==='announcing'?'Chuẩn bị vào vị trí':d.phase==='busy'?'Đang chụp':'Sẵn sàng';meta.textContent=d.queueLength?d.queueLength+' khách đang chờ':'Chưa có khách trong hàng chờ';if(d.phase==='announcing'&&d.guestName){hero.innerHTML='<p class="label">Xin mời khách tiếp theo</p><h1 id="guest"></h1><div class="callout"><div class="count" id="count"></div><p class="instruction">Chuẩn bị trước máy ảnh — phiên chụp sắp bắt đầu.</p></div>';document.querySelector('#guest').textContent=d.guestName;const c=document.querySelector('#count');c.textContent=seconds??'';if(previous!==seconds)c.classList.add('pulse');previous=seconds}else if(d.phase==='busy')hero.innerHTML='<p class="idle">Đang chụp ảnh.<br>Hãy nhìn vào ống kính.</p>';else hero.innerHTML='<p class="idle">Vui lòng chờ lượt chụp tiếp theo.</p>'}async function poll(){try{draw(await(await fetch('/display-state',{cache:'no-store'})).json())}catch{}setTimeout(poll,250)}poll();
</script></body></html>`

export function createTriggerServer(config: TriggerServerConfig, logger: Logger) {
  const app = express()
  let displayState: AgentDisplayState = { phase: 'idle', guestName: null, endsAt: null, queueLength: 0, upNext: [] }
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())

  // Always return 200 immediately - dslrBooth expects this
  app.get('/dslrbooth-event', (req: Request, res: Response) => {
    const eventType = req.query.event_type as string
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== 'event_type' && typeof value === 'string') {
        params[key] = value
      }
    }

    if (eventType) {
      logger.info(`Trigger received: ${eventType} ${JSON.stringify(params)}`)
      config.onEvent(eventType, params)
    }
    res.sendStatus(200)
  })

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now() })
  })

  app.get('/display', (_req: Request, res: Response) => res.type('html').send(displayPage))
  app.get('/display-state', (_req: Request, res: Response) => res.json(displayState))

  // Error handler - never crash
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Trigger server error: ${err.message}`)
    res.sendStatus(200)
  })

  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Trigger HTTP server listening on port ${config.port}`)
  })

  return {
    updateDisplay: (next: Partial<AgentDisplayState>) => { displayState = { ...displayState, ...next } },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}
