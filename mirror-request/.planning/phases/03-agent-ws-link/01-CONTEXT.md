# Phase 3: Agent WebSocket Link

## Mục tiêu
Kết nối Extension Service ↔ Agent qua WebSocket: gửi lệnh, nhận ack/event/heartbeat.

## Thiết kế
- WS endpoint: /agent trên cùng port (Express upgrade event)
- Auth: token handshake — AGENT_WS_TOKEN từ env
- Message format: JSON discriminated union { type: 'command' | 'ack' | 'event' | 'heartbeat' }
- Phase 2 coupling: QueueService gọi agentServer.sendCommand() khi dispatch, nhận ack/event qua handler callbacks

## Files mới
- src/agent/agentServer.ts

## Files modified
- src/index.ts (wire AgentServer)
- src/queue/queueService.ts (plug WS send/receive)

## Plan summary
1. WS server + token auth
2. sendCommand() method
3. Receive ack + event messages
4. Wire into server + QueueService
5. Heartbeat watchdog + online/offline status
6. Integration test (vitest + ws client, 7 test cases)
