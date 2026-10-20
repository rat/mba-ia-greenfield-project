import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VideoProcessingService } from './video-processing.service';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

/**
 * Consumer of the `video-processing` queue. Concurrency is intentionally low
 * because each job is CPU-bound (FFmpeg) — see phase-03-videos/TD-03.
 */
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    if (job.name !== PROCESS_VIDEO_JOB) {
      this.logger.warn(`Ignoring unknown job "${job.name}"`);
      return;
    }

    this.logger.log(
      `Processing video ${job.data.videoId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.processing.process(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData> | undefined, error: Error): void {
    this.logger.error(
      `Job ${job?.id ?? 'unknown'} failed for video ${job?.data?.videoId ?? 'unknown'}: ${error.message}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessVideoJobData>): void {
    this.logger.log(`Job ${job.id} completed for video ${job.data.videoId}`);
  }
}
