# Phase Plan: M2 — Integration Hardening

**Milestone**: M2 — Integration Hardening  
**Goal**: Validate Agent works end-to-end with real dslrBooth + Extension Service on booth machine  
**Prerequisites**: M1 complete (core Agent built and unit-tested)

---

## Phase 1: Build & Deploy to Booth Machine

### Task M2-P1.1: Build Production Bundle
```bash
# On dev machine
cd dslrbooth-agent
npm run build
# Verify dist/ exists with .js and .map files
```

**Acceptance**: `dist/index.js` and all modules compiled without TypeScript errors

### Task M2-P1.2: Copy to Target Machine
```powershell
# On booth machine (Admin PowerShell)
mkdir C:\dslrbooth-agent
# Copy from dev machine: dist/, service/, .env.example
# Rename .env.example → .env
```

**Acceptance**: `C:\dslrbooth-agent\dist\index.js` exists

### Task M2-P1.3: Configure Booth-Specific .env
```env
# C:\dslrbooth-agent\.env
EXTENSION_SERVICE_WS_URL=ws://your-extension-host:8080/agent
DSLRBOOTH_API_PORT=1500
DSLRBOOTH_PASSWORD=your-actual-password-from-dslrbooth
TRIGGER_SERVER_PORT=3001
LOG_LEVEL=info
LOG_DIR=logs
```

**Acceptance**: All required fields populated; `EXTENSION_SERVICE_WS_URL` reachable

### Task M2-P1.4: Install Windows Service
```powershell
# Run as Administrator
cd C:\dslrbooth-agent
npm install --production
npm run service:install
# Verify in services.msc: "dslrBooth Agent" status = Running
```

**Acceptance**: Service installed, running, logs show "WebSocket connected"

---

## Phase 2: Configure dslrBooth

### Task M2-P2.1: Record dslrBooth API Settings
- Open dslrBooth → Settings → General → API
- Note: **Port** (default 1500), **Password** (copy exactly)
- Verify in `.env`: `DSLRBOOTH_API_PORT` and `DSLRBOOTH_PASSWORD` match

**Acceptance**: Agent `.env` matches dslrBooth settings exactly

### Task M2-P2.2: Configure Trigger URL
- Settings → General → Triggers
- **URL**: `http://127.0.0.1:3001/dslrbooth-event`
- **Method**: GET
- Save

**Acceptance**: dslrBooth will call Agent on session events

### Task M2-P2.3: Test Trigger Endpoint
```powershell
# On booth machine
curl "http://127.0.0.1:3001/dslrbooth-event?event_type=test&param1=hello"
# Expected: "OK" (200)
```
Check Agent logs: `Trigger received: test params={"param1":"hello"}`
Check Extension Service logs: Received `event` message with `event: "test"`

**Acceptance**: 200 OK returned; event logged and forwarded

---

## Phase 3: Connect Extension Service

### Task M2-P3.1: Start Extension Service Dev Instance
- Ensure Extension Service WebSocket server running
- Note WS URL (e.g., `ws://192.168.1.100:8080/agent`)
- Verify matches `.env` `EXTENSION_SERVICE_WS_URL`

**Acceptance**: Extension Service WS endpoint accepting connections

### Task M2-P3.2: Verify Agent WS Connection
```powershell
# Check Agent logs (real-time)
Get-Content C:\dslrbooth-agent\logs\app-*.log -Tail 20 -Wait
```
Look for: `WebSocket connected to Extension Service`

**Acceptance**: WS connected log entry present

### Task M2-P3.3: Verify Heartbeat
In logs, every ~15s: `Heartbeat sent` and Extension Service receives `heartbeat` message

**Acceptance**: Heartbeat flowing bidirectionally

---

## Phase 4: End-to-End Session Test

### Task M2-P4.1: Trigger Full Session
**Option A**: Via Extension Service (send `start_session` command)
**Option B**: Via dslrBooth UI (Start button on booth)

**Acceptance**: Session initiates; dslrBooth begins countdown/capture

### Task M2-P4.2: Verify All Events Forwarded
Check Extension Service receives these 11 events in order:
1. `session_start` — `param1` = mode (PrintAndGIF, etc.)
2. `countdown_start` — `param1` = seconds (e.g., "5")
3. `countdown` — repeated (each tick)
4. `capture_start` — photo taken
5. `file_download` — `param1` = filename
6. `processing_start` — processing begins
7. `sharing_screen` — sharing UI shown
8. `file_upload` — `param1`=file, `param2`=url, `param3`=type, `param4`=album
9. `printing` — `param1`=file, `param2`=copies, `param3`=printer
10. *(optional intermediate events)*
11. `session_end` — **critical**: booth idle again

**Acceptance**: All 11 event types logged by Extension Service

### Task M2-P4.3: Verify Command Acknowledgment
For `start_session` command, Extension Service receives:
```json
{ "type": "ack", "jobId": "uuid", "ok": true, "errorMessage": "" }
```

**Acceptance**: `ack.ok=true` for successful API call

---

## Phase 5: Failure Mode Testing

### Task M2-P5.1: Extension Service Disconnect/Reconnect
1. Stop Extension Service process
2. Wait 15s (observe Agent logs: "WebSocket closed", "Reconnecting in 2000ms", ...)
3. Restart Extension Service
4. Verify Agent reconnects automatically (log: "WebSocket connected")
5. Verify heartbeats resume

**Acceptance**: Reconnect < 30s; no manual intervention

### Task M2-P5.2: dslrBooth API Offline
1. Stop dslrBooth application
2. Send `start_session` command from Extension Service
3. Verify Agent logs API error, sends `ack.ok=false` with error message
4. Verify Agent does NOT crash (continues running, WS still connected)
5. Restart dslrBooth, send command again — should succeed

**Acceptance**: Graceful error handling, no crash, recovery works

### Task M2-P5.3: Machine Reboot
1. Reboot booth machine (Start → Restart)
2. Wait for boot completion (~60s)
3. Check services.msc: "dslrBooth Agent" = Running
4. Check Agent logs: startup sequence, WS connect, heartbeats
5. Test trigger endpoint: `curl "http://127.0.0.1:3001/dslrbooth-event?event_type=test"`
6. Test full session end-to-end

**Acceptance**: Service auto-starts; fully functional post-reboot

### Task M2-P5.4: Network Latency/Partition (Optional)
Use `clumsy` or Windows `netsh` to add 500ms latency / 5% packet loss on port 3001 and WS port.
Verify: no message loss, heartbeats still work, reconnects on partition.

**Acceptance**: Degraded network handled gracefully

---

## Phase 6: Security & Log Validation

### Task M2-P6.1: Password Not in Logs
```powershell
# Search for password in all logs
Select-String -Path "C:\dslrbooth-agent\logs\*.log" -Pattern "DSLRBOOTH_PASSWORD|your-actual-password"
# Must return ZERO matches
```

**Acceptance**: Zero occurrences of actual password value

### Task M2-P6.2: Log Rotation Verified
```powershell
ls C:\dslrbooth-agent\logs\
# Should see: app-YYYY-MM-DD.log (current), app-YYYY-MM-DD.log.gz (older)
```

**Acceptance**: Daily files, gzipped archives, max 14 days

### Task M2-P6.3: Config UI Local-Only Binding
```powershell
# From booth machine
curl http://127.0.0.1:3001/config
# Should return HTML form

# From ANOTHER machine on same LAN
curl http://<booth-ip>:3001/config
# Must FAIL (connection refused or timeout)
```

**Acceptance**: Config UI only accessible via localhost

### Task M2-P6.4: Config UI Basic Auth (Optional)
If implemented: accessing `/config` prompts for password.
Test wrong password → 401/403. Test correct password → form loads.

**Acceptance**: Password protection works

---

## Deliverables for M2 Completion

| Deliverable | Location |
|-------------|----------|
| Updated `.env` on booth machine | `C:\dslrbooth-agent\.env` |
| Integration test log (all events) | Extension Service logs + Agent logs |
| Failure mode test results | Document in `M2-TEST-RESULTS.md` |
| Security validation checklist | `M2-SECURITY-CHECKLIST.md` |
| Any code fixes needed | Commit to repo, rebuild, redeploy |

---

## Go/No-Go for M3

**M2 Complete When**:
- [ ] All 11 events captured and forwarded in correct order
- [ ] WS auto-reconnect verified (< 30s)
- [ ] dslrBooth API error handling verified (no crash)
- [ ] Machine reboot → service auto-starts, functional
- [ ] Zero password in logs
- [ ] Config UI localhost-only verified
- [ ] Any protocol mismatches fixed and re-tested

If all pass → proceed to M3 (Observability). If blockers → fix, re-test.

---

*Plan created: 2025-07-19*
*Milestone: M2 — Integration Hardening*
*Est. effort: 6-8 hours on booth machine*