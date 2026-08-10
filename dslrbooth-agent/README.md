# dslrBooth Agent

Stateless relay agent between **dslrBooth Local API** (Windows) and **Extension Service** (WebSocket).

## Architecture

```
dslrBooth Local API (HTTP :1500) ←→ Agent (this service) ←→ Extension Service (WebSocket)
         ↑                                               ↑
         └──── Trigger webhook :3001/dslrbooth-event ───┘
```

Agent responsibilities (stateless, no queue, no logic):
1. **WS ← Extension Service**: Receive `start_session` command → call dslrBooth `/api/start`
2. **Trigger → Agent**: dslrBooth calls `/dslrbooth-event?event_type=...` → forward to Extension Service via WS
3. **Heartbeat**: Send `heartbeat` every 15s via WS

## Prerequisites

- Windows 10/11 (for Windows Service)
- Node.js 20 LTS
- dslrBooth Professional for Windows v6.40+
- Extension Service WebSocket server running

## Quick Start

### 1. Install dependencies
```bash
npm install
npm run build
```

### 2. Configure `.env`

```env
EXTENSION_SERVICE_WS_URL=ws://your-extension-host:8080/agent
DSLRBOOTH_API_PORT=1500
DSLRBOOTH_PASSWORD=your-api-password-from-dslrbooth
TRIGGER_SERVER_PORT=3001
LOG_LEVEL=info
LOG_DIR=logs
```

### 3. dslrBooth Settings
In dslrBooth **Settings → General → Triggers**:
- **URL**: `http://127.0.0.1:3001/dslrbooth-event`
- **Method**: GET

### 4. Run directly (dev)
```bash
npm run dev
```

### 5. Install as Windows Service (production)
```bash
npm run service:install
```
Service name: **`dslrBooth Agent`** — auto-starts on boot, restarts on crash.

### 6. Uninstall service
```bash
npm run service:uninstall
```

## Logs
- Runtime logs: `logs/app-YYYY-MM-DD.log` (daily rotation, 14-day retention)
- No secrets logged (password filtered)

## WebSocket Messages

**Extension Service → Agent**
```json
{ "type": "command", "action": "start_session", "mode": "print", "jobId": "uuid" }
```

**Agent → Extension Service (ack)**
```json
{ "type": "ack", "jobId": "uuid", "ok": true, "errorMessage": "" }
```

**Agent → Extension Service (event from dslrBooth)**
```json
{ "type": "event", "event": "session_end", "params": {}, "timestamp": 1234567890 }
```

**Agent → Extension Service (heartbeat)**
```json
{ "type": "heartbeat", "timestamp": 1234567890 }
```

## dslrBooth Events (via Trigger)
```
session_start     - session begins
countdown_start   - countdown began
countdown         - each countdown tick
capture_start     - photo captured
file_download     - file downloaded from camera
processing_start  - processing started
sharing_screen    - sharing screen shown
file_upload       - file uploaded to cloud
printing          - print job sent
session_end       - session complete (booth idle)
```

## Error Handling
- dslrBooth API errors → logged, `ack.ok=false`
- WS disconnect → exponential backoff reconnect (2s → 30s max)
- Trigger server always returns 200 (no dslrBooth retries)
- Uncaught exceptions/unhandled rejections logged, process exits cleanly

## Security
- `.env` in `.gitignore` — never commit
- `DSLRBOOTH_PASSWORD` never logged
- Trigger server binds to `0.0.0.0:3001` (firewall as needed)

## Development
```bash
npm run dev      # ts-node with hot reload
npm run build    # TypeScript compile to dist/
npm start        # Run compiled JS
```

## License
Internal use only.