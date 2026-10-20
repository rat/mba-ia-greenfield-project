import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';
import { PROCESS_VIDEO_JOB, ProcessVideoJobData } from './videos.constants';

function buildJob(
  overrides: Partial<Job<ProcessVideoJobData>> = {},
): Job<ProcessVideoJobData> {
  return {
    id: 'job-1',
    name: PROCESS_VIDEO_JOB,
    attemptsMade: 0,
    data: { videoId: 'video-1', storageKey: 'videos/channel-1/abc' },
    ...overrides,
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let processing: { process: jest.Mock };

  beforeEach(async () => {
    processing = { process: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: processing },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  it('delegates process-video jobs to the processing service', async () => {
    await processor.process(buildJob());

    expect(processing.process).toHaveBeenCalledWith({
      videoId: 'video-1',
      storageKey: 'videos/channel-1/abc',
    });
  });

  it('ignores unknown job names', async () => {
    await processor.process(buildJob({ name: 'unknown-job' }));

    expect(processing.process).not.toHaveBeenCalled();
  });

  it('propagates processing failures so BullMQ can retry', async () => {
    processing.process.mockRejectedValueOnce(new Error('ffmpeg exploded'));

    await expect(processor.process(buildJob())).rejects.toThrow(
      'ffmpeg exploded',
    );
  });

  it('logs failed and completed worker events without throwing', () => {
    expect(() =>
      processor.onFailed(buildJob(), new Error('boom')),
    ).not.toThrow();
    expect(() => processor.onFailed(undefined, new Error('boom'))).not.toThrow();
    expect(() => processor.onCompleted(buildJob())).not.toThrow();
  });
});
