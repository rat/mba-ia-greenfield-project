import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();

    await moduleRef.init();
    queue = moduleRef.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    await queue.drain(true);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('connects to Redis and reports the queue as ready', async () => {
    const client = (await queue.client) as unknown as {
      ping: () => Promise<string>;
    };

    await expect(client.ping()).resolves.toBe('PONG');
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  });

  it('enqueues a job with the configured retry policy', async () => {
    const job = await queue.add(PROCESS_VIDEO_JOB, {
      videoId: 'video-1',
      storageKey: 'videos/channel-1/abc',
    });

    expect(job.id).toBeDefined();
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });

    const waiting = await queue.getWaiting();
    expect(waiting.map((j) => ({ ...j.data }))).toEqual([
      { videoId: 'video-1', storageKey: 'videos/channel-1/abc' },
    ]);
  });
});
