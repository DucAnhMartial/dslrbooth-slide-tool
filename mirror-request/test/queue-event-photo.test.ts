import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueService, queueLogger } from '../src/queue/queueService';
import type { LocalStore } from '../src/state/localStore';
import { createPendingPrintRegistry, type PendingPrintRow } from './helpers/pendingPrintRegistry';

/**
 * D-10 photo history, written at the attribution point Phase 4 already proved
 * correct: the pending-print registry's resolve, not the booth's current job.
 *
 * The four branches of `onFileUpload()` are the whole subject. Two of them are
 * real captures and must each leave exactly one durable `event_photo` row; the
 * other two must leave none. Getting that split wrong is silent in both
 * directions — a lost branch loses a guest's photo from the wall forever, and
 * a spurious branch fabricates history for a guest who never shot.
 *
 * D-04 is pinned alongside it in every case: this write is ADDITIVE. The
 * webhook keeps delivering the guest their photo on exactly the branches it
 * delivers on today, so every case asserts the `sendPhotoLink` call count as
 * well as the row count. A change that moved delivery onto the history write's
 * condition would pass a row-count-only suite.
 *
 * The store is mocked at the SQLite seam. `recordEventPhoto`'s own SQL —
 * including the INSERT OR IGNORE that makes a replay a no-op at the database
 * level — is proved separately against a real temp-file database in
 * test/local-store-persistence.test.ts. Neither file substitutes for the other.
 */

const PHOTO_URL = 'https://fotoshare.co/i/1t1vcs3';
const COMPOSITE_PATH = 'C:\\dslrBooth\\Test_event\\Prints\\20260812_143526_970.jpg';

interface RecordedPhoto {
  jobId: string;
  eventId: string;
  guestName: string;
  photoUrl: string;
  capturedAt: number;
}

/**
 * `pendingStatus: 'none'` seeds NO row at all — the D-04 branch where no
 * session ever opened a slot for this job, which is a different thing from a
 * slot that exists and has already been resolved.
 */
function buildStore(opts: {
  pendingStatus: 'awaiting' | 'expired' | 'resolved' | 'none';
  activeEventId?: string | undefined;
  guestName?: string;
  jobId?: string;
} ) {
  const jobId = opts.jobId ?? 'job-1';
  const seed: PendingPrintRow[] =
    opts.pendingStatus === 'none'
      ? []
      : [{
          jobId,
          compositePath: COMPOSITE_PATH,
          status: opts.pendingStatus,
          openedAt: Date.now() - 60_000,
          expiresAt: Date.now() - 1_000,
        }];
  const registry = createPendingPrintRegistry(seed);

  const recorded: RecordedPhoto[] = [];
  const recordEventPhoto = vi.fn((photo: RecordedPhoto) => {
    // Mirrors INSERT OR IGNORE: the first write for a jobId wins and a second
    // one changes nothing and returns false.
    if (recorded.some((p) => p.jobId === photo.jobId)) return false;
    recorded.push({ ...photo });
    return true;
  });

  const getActiveEventId = vi.fn(() => opts.activeEventId);
  const getJobRegistration = vi.fn((id: string) => ({
    job: { id },
    registration: {
      id: 'reg-1',
      name: opts.guestName ?? 'Nguyễn Thị Hồng Ánh',
      email: '',
      phone: '',
      mode: 'standard',
      registered_at: '',
    },
  }));

  const store = {
    getBoothState: () => 'IDLE',
    getBoothStateDetailed: () => ({ state: 'IDLE', updated_at: new Date().toISOString() }),
    getInFlightJobs: () => [],
    getNextQueuedJob: () => undefined,
    getBoothCurrentJobId: () => undefined,
    getJob: (id: string) => ({ id, status: 'in_progress' }),
    updateJobStatus: () => {},
    getQueuedGuestSummaries: () => [],
    getQueueLength: () => 0,
    getQueuePosition: () => undefined,
    getJobsAwaitingNoPhotoClose: () => [],
    ...registry.registry,
    getJobRegistration,
    getActiveEventId,
    recordEventPhoto,
  } as unknown as LocalStore;

  return { store, recorded, recordEventPhoto, getActiveEventId, getJobRegistration, jobId };
}

/** The QueueService is never started here: `onAgentEvent` is called directly,
 * so no dispatch tick, announcement or busy timer runs and nothing but the
 * upload path can touch the spies. */
function buildService(store: LocalStore) {
  const sendPhotoLink = vi.fn(async () => {});
  const service = new QueueService(store);
  service.bindSendCommand(() => {});
  service.bindNotificationService({ sendPhotoLink });
  return { service, sendPhotoLink };
}

function upload(service: QueueService, jobId: string): void {
  service.onAgentEvent('file_upload', jobId, {
    param2: PHOTO_URL,
    param3: 'print',
    param4: 'Test_event',
  });
}

describe('QueueService.onFileUpload — photo history (D-10) is additive to delivery (D-04)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes exactly one event_photo row on the ordinary awaiting resolve, and still delivers', async () => {
    const { store, recorded, jobId } = buildStore({ pendingStatus: 'awaiting', activeEventId: 'evt-1' });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);
    await vi.waitFor(() => expect(sendPhotoLink).toHaveBeenCalledTimes(1));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      jobId,
      eventId: 'evt-1',
      guestName: 'Nguyễn Thị Hồng Ánh',
      photoUrl: PHOTO_URL,
    });
    expect(typeof recorded[0].capturedAt).toBe('number');
    // D-04: delivery is unchanged, not conditional on the history write.
    expect(sendPhotoLink).toHaveBeenCalledWith(jobId, PHOTO_URL);
  });

  it('writes exactly one event_photo row on the late-but-legitimate expired resolve', async () => {
    const { store, recorded, jobId } = buildStore({ pendingStatus: 'expired', activeEventId: 'evt-1' });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);
    await vi.waitFor(() => expect(sendPhotoLink).toHaveBeenCalledTimes(1));

    // A real photo arriving late is still a real photo — it belongs in history
    // exactly as much as an on-time one does.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ jobId, eventId: 'evt-1', photoUrl: PHOTO_URL });
  });

  it('writes no row and delivers nothing when no session ever opened a slot for the job', () => {
    const { store, recorded, recordEventPhoto, jobId } = buildStore({
      pendingStatus: 'none',
      activeEventId: 'evt-1',
    });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);

    // The D-04 branch: a stranger pressing start on the booth's own screen
    // must not reach a real guest's history OR their inbox.
    expect(recordEventPhoto).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
    expect(sendPhotoLink).not.toHaveBeenCalled();
  });

  it('writes no second row and sends no second notification for a replayed resolve', async () => {
    const { store, recorded, jobId } = buildStore({ pendingStatus: 'awaiting', activeEventId: 'evt-1' });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);
    await vi.waitFor(() => expect(sendPhotoLink).toHaveBeenCalledTimes(1));
    expect(recorded).toHaveLength(1);

    const warn = vi.spyOn(queueLogger, 'warn');
    upload(service, jobId); // the replay: resolvePendingPrint now returns false

    expect(recorded).toHaveLength(1);
    expect(sendPhotoLink).toHaveBeenCalledTimes(1);
    // No warning storm: the replay is an ordinary, expected no-op, not an
    // incident. The 'resolved' row is neither undefined nor 'expired', so it
    // takes the silent false-return path.
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes no row and logs exactly one masked warn naming the job when no event is active', async () => {
    const warn = vi.spyOn(queueLogger, 'warn');
    const { store, recorded, jobId } = buildStore({ pendingStatus: 'awaiting', activeEventId: undefined });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);
    await vi.waitFor(() => expect(sendPhotoLink).toHaveBeenCalledTimes(1));

    expect(recorded).toHaveLength(0);
    // Delivery is emphatically NOT gated on there being an active event: the
    // guest is owed their photo whether or not the CMS has been set up.
    expect(sendPhotoLink).toHaveBeenCalledWith(jobId, PHOTO_URL);

    const lines = warn.mock.calls.filter((call) => String(call[0]).includes(jobId));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toMatch(/history/i);
    // T-08-08: a plain string, never an object. winston's masking formatters
    // only run on `typeof message === 'string'`, so an object-form log line
    // would push an unmasked guest name straight into the log file.
    expect(typeof lines[0][0]).toBe('string');
    expect(lines[0]).toHaveLength(1);
  });

  it('does not record a row for a non-print upload, which never reaches the resolve at all', () => {
    const { store, recordEventPhoto, jobId } = buildStore({ pendingStatus: 'awaiting', activeEventId: 'evt-1' });
    const { service, sendPhotoLink } = buildService(store);

    service.onAgentEvent('file_upload', jobId, { param2: PHOTO_URL, param3: 'original' });

    expect(recordEventPhoto).not.toHaveBeenCalled();
    expect(sendPhotoLink).not.toHaveBeenCalled();
  });

  it('attributes the row to the registration join, not to whatever job holds the booth', async () => {
    const { store, recorded, getJobRegistration, jobId } = buildStore({
      pendingStatus: 'awaiting',
      activeEventId: 'evt-1',
      guestName: 'Đặng Vũ Khánh Ly',
    });
    const { service, sendPhotoLink } = buildService(store);

    upload(service, jobId);
    await vi.waitFor(() => expect(sendPhotoLink).toHaveBeenCalledTimes(1));

    // statusRoute.ts:134's join, reused identically — the method that already
    // fixed a live bug caused by reading `.registration` off a bare row.
    expect(getJobRegistration).toHaveBeenCalledWith(jobId);
    expect(recorded[0].guestName).toBe('Đặng Vũ Khánh Ly');
  });
});
