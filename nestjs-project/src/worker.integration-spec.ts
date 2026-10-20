import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { cleanAllTables } from './test/create-test-data-source';
import { VideoProcessingService } from './videos/video-processing.service';
import { VideoProcessor } from './videos/video.processor';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;
  let processingService: VideoProcessingService;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(VideoProcessingService)
      .useValue({
        process: jest.fn().mockResolvedValue(undefined),
      })
      .compile();

    // BullMQ workers in NestJS only start after the app is fully initialized
    await moduleRef.init();
    
    // We also need to ensure the worker is actually running. 
    // BullMQ workers start listening on the 'ready' event of the connection.
    // In some test environments, we might need a small delay.
    await new Promise(r => setTimeout(r, 1000));

    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    processingService = moduleRef.get(VideoProcessingService);
    // Force instantiation of the processor if it hasn't been yet
    moduleRef.get(VideoProcessor);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  it('should consume a job from the queue when registered in WorkerModule', async () => {
    const jobData = { videoId: 'video-1', storageKey: 'videos/1/abc' };
    
    // Add job to queue
    await queue.add(PROCESS_VIDEO_JOB, jobData);
    console.log('Job added to queue');

    // Wait for worker to pick it up (it's async)
    let attempts = 0;
    while (attempts < 100) {
      const count = (processingService.process as jest.Mock).mock.calls.length;
      if (count > 0) {
        console.log(`Job picked up after ${attempts} attempts`);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    expect(processingService.process).toHaveBeenCalledWith(jobData);
  }, 30000);
});
