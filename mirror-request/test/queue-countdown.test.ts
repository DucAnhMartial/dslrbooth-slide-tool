import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';

describe('Queue countdown with multiple registrations', () => {
  afterEach(() => vi.useRealTimers());

  it('announces and dispatches requests one at a time in FIFO order', () => {
    vi.useFakeTimers();
    const queued = [{ id: 'form-a' }, { id: 'form-b' }, { id: 'form-c' }];
    let booth = 'IDLE';
    const completed: string[] = [];
    const store = {
      getBoothState: () => booth,
      getNextQueuedJob: () => queued[0],
      setBoothState: (state: string) => { booth = state; },
      setBoothBusy: () => { booth = 'BUSY'; },
      setBoothIdle: () => { booth = 'IDLE'; },
      setBoothTimeout: () => { booth = 'IDLE'; },
      updateJobStatus: (id: string, status: string) => {
        if (status === 'dispatched') queued.splice(queued.findIndex(job => job.id === id), 1);
      },
      completeInProgressJob: () => {
        const id = completed.length === 0 ? 'form-a' : 'form-b';
        completed.push(id);
        return id;
      },
      getQueuePosition: () => 1,
      getQueueLength: () => queued.length,
      getQueuedGuestSummaries: () => queued.map((job, index) => ({ jobId: job.id, name: `Guest ${job.id}`, position: index + 1 })),
    } as unknown as LocalStore;
    const service = new QueueService(store);
    const dispatched: string[] = [];
    service.bindSendCommand(command => dispatched.push(command.jobId));

    service.start();
    vi.advanceTimersByTime(250);
    expect(booth).toBe('ANNOUNCING');
    expect(service.getAnnouncement()?.jobId).toBe('form-a');
    expect(dispatched).toEqual([]);

    vi.advanceTimersByTime(7_000);
    expect(dispatched).toEqual(['form-a']);
    expect(booth).toBe('BUSY');

    service.onAgentAck('form-a', true);
    service.sessionEnded();
    expect(service.getAnnouncement()?.jobId).toBe('form-b');
    vi.advanceTimersByTime(7_000);
    expect(dispatched).toEqual(['form-a', 'form-b']);
    expect(queued.map(job => job.id)).toEqual(['form-c']);
    service.stop();
  });
});
