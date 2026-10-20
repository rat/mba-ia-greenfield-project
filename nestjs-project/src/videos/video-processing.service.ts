import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ffmpeg from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoMetadata, VideoStatus } from './entities/video.entity';
import { ProcessVideoJobData } from './videos.constants';
import { VideoNotFoundException } from './videos.exceptions';

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

const THUMBNAIL_FILENAME = 'thumbnail.jpg';
const THUMBNAIL_SIZE = '640x?';

/**
 * Performs the heavy lifting of phase 03: it downloads the uploaded object,
 * probes it with ffprobe to extract the real duration and technical metadata,
 * generates a thumbnail at the middle of the video and pushes it back to the
 * storage (phase-03-videos/TD-03).
 *
 * Runs inside the dedicated worker process so that CPU-bound FFmpeg work never
 * blocks the HTTP API.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  async process(job: ProcessVideoJobData): Promise<void> {
    const video = await this.videos.findOne({ where: { id: job.videoId } });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${video.id}-`));
    const localVideoPath = join(workDir, 'source');

    try {
      await this.storage.downloadToFile(job.storageKey, localVideoPath);

      const probe = await this.probe(localVideoPath);
      const { size } = await stat(localVideoPath);

      const thumbnailPath = await this.generateThumbnail(
        localVideoPath,
        workDir,
        probe.durationSeconds,
      );
      const thumbnailKey = this.storage.buildThumbnailObjectKey(
        video.channel_id,
        video.video_url_id,
      );
      await this.storage.uploadFile(thumbnailKey, thumbnailPath, 'image/jpeg');

      await this.videos.update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          duration: Math.round(probe.durationSeconds),
          metadata: { ...probe.metadata, size_bytes: size },
          thumbnail_key: thumbnailKey,
          processing_error: null,
        },
      );

      this.logger.log(
        `Video ${video.id} processed successfully (${Math.round(probe.durationSeconds)}s)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to process video ${video.id}: ${message}`);

      await this.videos.update(
        { id: video.id },
        { status: VideoStatus.ERROR, processing_error: message },
      );

      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Extracts duration and technical metadata using ffprobe. */
  async probe(localPath: string): Promise<ProbeResult> {
    const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(localPath, (err, metadata) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(metadata);
      });
    });

    const videoStream = data.streams.find((s) => s.codec_type === 'video');
    const audioStream = data.streams.find((s) => s.codec_type === 'audio');
    const durationSeconds = Number(
      data.format?.duration ?? videoStream?.duration ?? 0,
    );

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Could not determine the video duration');
    }

    return {
      durationSeconds,
      metadata: {
        width: videoStream?.width,
        height: videoStream?.height,
        video_codec: videoStream?.codec_name,
        audio_codec: audioStream?.codec_name,
        bit_rate: data.format?.bit_rate
          ? Number(data.format.bit_rate)
          : undefined,
        format_name: data.format?.format_name,
      },
    };
  }

  /** Captures a single frame at the middle of the video as the thumbnail. */
  async generateThumbnail(
    localPath: string,
    workDir: string,
    durationSeconds: number,
  ): Promise<string> {
    const timestamp = Math.max(durationSeconds / 2, 0);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(localPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: [timestamp],
          filename: THUMBNAIL_FILENAME,
          folder: workDir,
          size: THUMBNAIL_SIZE,
        });
    });

    return join(workDir, THUMBNAIL_FILENAME);
  }
}
