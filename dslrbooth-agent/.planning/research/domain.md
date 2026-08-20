# Domain Research: dslrBooth Agent

## 1. dslrBooth / LumaBooth for Windows

### API Capabilities
- **Local REST API**: HTTP GET on configurable port (default 1500)
- **Authentication**: Password query param `?password=xxx`
- **Actions**: `start`, `stop`, `capture`, `print`, `reprint`, `email`, `sms`, `gallery`
- **Modes**: `print`, `gif`, `video`, `boomerang`, `photobooth`, `green-screen`
- **Response format**: JSON with `ApiVersion`, `Command`, `IsSuccessful`, `ErrorMessage`
- **Minimum version**: v6.40 Professional for Windows

### Triggers / Webhooks
- **Configuration**: Settings → General → Triggers → URL
- **Method**: GET (hardcoded in dslrBooth)
- **URL pattern**: `http(s)://host:port/path?event_type=xxx&param1=yyy...`
- **Authentication**: None (runs locally)
- **Events**:
  - `session_start` — session begins, `param1` = mode
  - `countdown_start` — countdown begins, `param1` = seconds
  - `countdown` — each tick
  - `capture_start` — photo captured
  - `file_download` — file downloaded from camera, `param1` = filename
  - `processing_start` — processing started
  - `sharing_screen` — sharing UI shown
  - `file_upload` — upload complete, `param1`=file, `param2`=url, `param3`=type, `param4`=album
  - `printing` — print job sent, `param1`=file, `param2`=copies, `param3`=printer
  - `session_end` — session complete (booth idle)

### Settings Reference
| Setting | Path | Default |
|---------|------|---------|
| API Port | Settings → General → API → Port | 1500 |
| API Password | Settings → General → API → Password | (generated) |
| Trigger URL | Settings → General → Triggers → URL | (empty) |
| Trigger Method | Settings → General → Triggers → Method | GET |

**Official docs**: https://dsphotoboothsoftware.com/help/ (v6.40+)

---

## 2. Windows Service Best Practices

### node-windows (v1.0.0-beta.8)
- Wrapper around WinSW (Windows Service Wrapper)
- **Install**: Creates service in Service Control Manager
- **Auto-start**: `startType: 'auto'` — runs before user login
- **Restart**: Configurable `maxRetries`, `grow` factor
- **Working directory**: Must be set to project root
- **Environment**: Passed via `env` array in service config
- **Logging**: Stdout/stderr to files or Windows Event Log
- **Uninstall**: Clean removal from SCM

### Reliability Patterns
```javascript
const svc = new Service({
  name: 'dslrBooth Agent',
  script: 'C:\\path\\dist\\index.js',
  nodeOptions: ['-r', 'dotenv/config'],  // load .env
  env: { name: 'EXTENSION_SERVICE_WS_URL', value: 'ws://...' },
  workingDirectory: 'C:\\path',
  wait: 5,           // seconds between restarts
  grow: 0.25,        // exponential backoff factor
  maxRetries: 3,     // max restart attempts
});
```

### Crash Recovery
- Services auto-restart on crash (configured in SCM Recovery tab)
- Use `process.on('uncaughtException')` and `unhandledRejection` for graceful logging
- Heartbeat to external monitor (Extension Service) for liveness

---

## 3. WebSocket Patterns

### Auto-Reconnect with Exponential Backoff
```typescript
const baseDelay = 2000;  // 2s
const maxDelay = 30000;  // 30s
let delay = baseDelay;

ws.on('close', () => {
  delay = Math.min(delay * 2, maxDelay);
  setTimeout(connect, delay);
});

ws.on('open', () => {
  delay = baseDelay;  // reset on success
});
```

### Heartbeat / Ping-Pong
- **Agent sends**: `{"type": "heartbeat", "timestamp": 1234567890}` every 15s
- **Server responds**: Optional pong or echo
- **Detection**: Missed 2-3 heartbeats → assume dead, reconnect

### Message Acknowledgment
- Extension Service → Agent: `{type: "command", action: "start_session", jobId: "uuid"}`
- Agent → Extension Service: `{type: "ack", jobId: "uuid", ok: true, errorMessage: ""}`
- **At-least-once delivery**: Client retries on no-ack; server idempotent on jobId

---

## 4. Stateless Relay Patterns

### Design Principles
1. **No local state** — no queue, no booth status, no job tracking
2. **Pure transformation** — WS message ↔ HTTP call ↔ Trigger forward
3. **Idempotent operations** — safe to retry on network blips
4. **Fire-and-forget forward** — trigger receipt → 200 OK immediately, forward async

### Message Flow
```
Extension Service          Agent                    dslrBooth
     │                      │                         │
     ├─ command ───────────►│                         │
     │        (start)       │                         │
     │                      ├─ GET /api/start ───────►│
     │                      │◄─ IsSuccessful: true ───┤
     │◄─────── ack ─────────┤                         │
     │                      │                         │
     │                      │          (triggers)     │
     │                      │◄─ GET /trigger?event...─┤
     │                      │    200 OK              │
     │◄─────── event ───────┤                         │
     │   (session_end)      │                         │
```

---

## 5. Secret Management

### dotenv Best Practices
- `.env` in `.gitignore` — **never committed**
- `.env.example` committed as template
- **Validation at startup** — fail fast if required vars missing
- **Never log secrets** — filter from all logs

### Windows Service Environment
```javascript
env: [
  { name: 'EXTENSION_SERVICE_WS_URL', value: process.env.EXTENSION_SERVICE_WS_URL },
  { name: 'DSLRBOOTH_PASSWORD', value: process.env.DSLRBOOTH_PASSWORD },
  { name: 'DSLRBOOTH_API_PORT', value: process.env.DSLRBOOTH_API_PORT },
  { name: 'TRIGGER_SERVER_PORT', value: process.env.TRIGGER_SERVER_PORT },
]
```

### Logging Filter
```javascript
// Winston filter to redact password
function redactPassword(info) {
  if (info.message?.includes?.('password')) {
    info.message = info.message.replace(/password=[^&\s]+/gi, 'password=***');
  }
  return info;
}
```

---

## 6. Integration Testing

### With Real dslrBooth
1. Install dslrBooth Professional v6.40+ on Windows test machine
2. Configure API port/password in Settings
3. Set Trigger URL to `http://127.0.0.1:3001/dslrbooth-event`
4. Start Agent (dev mode: `npm run dev`)
5. Initiate session from dslrBooth UI or Extension Service
6. Verify: triggers received, acks sent, heartbeat flowing

### Mock Testing (Unit/CI)
```typescript
// Mock dslrBooth API
const mockApi = nock('http://127.0.0.1:1500')
  .get('/api/start')
  .query({ password: 'test' })
  .reply(200, { IsSuccessful: true, ErrorMessage: '' });

// Mock WebSocket
const mockWs = new MockWebSocket();
mockWs.on('message', (msg) => {
  if (msg.type === 'command') {
    mockWs.send({ type: 'ack', jobId: msg.jobId, ok: true });
  }
});
```

### CI/CD for Windows Agents
- **GitHub Actions**: `windows-latest` runner
- **Build**: `npm run build`
- **Test**: Unit tests + integration test against mock
- **Package**: `pkg` or `nexe` for single executable (optional)
- **Deploy**: WinSW installer or copy `dist/` + `service/install-service.js`

---

## Recommendations for Agent v1.0

| Area | Recommendation |
|------|----------------|
| **dslrBooth API** | Validate `IsSuccessful` strictly; log `ErrorMessage` on failure |
| **Triggers** | Return 200 within 100ms; forward async via setImmediate |
| **WebSocket** | Reconnect base 2s, max 30s; heartbeat every 15s; send pong if server expects |
| **Secrets** | Redact password from all logs; pass via service `env` not `.env` file in production |
| **Service** | `wait: 5, grow: 0.25, maxRetries: 3`; log to Event Viewer + file |
| **Testing** | Manual integration test on booth machine required before deploy |

---

## Links
- dslrBooth Help: https://dsphotoboothsoftware.com/help/
- node-windows: https://github.com/node-windows/node-windows
- WinSW: https://github.com/winsw/winsw
- ws library: https://github.com/websockets/ws
- Winston: https://github.com/winstonjs/winston