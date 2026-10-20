import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateUploadIntentDto } from './dto/create-upload-intent.dto';
import {
  UploadIntentResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_URL_ID_LENGTH,
} from './videos.constants';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  NotVideoOwnerException,
  VideoFileMissingException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';

const URL_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** URL-safe, collision-resistant public id (phase-03-videos/TD-04). */
export const generateVideoUrlId = customAlphabet(
  URL_ID_ALPHABET,
  VIDEO_URL_ID_LENGTH,
);

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    @Inject(getQueueToken(VIDEO_PROCESSING_QUEUE))
    private readonly queue: Queue<ProcessVideoJobData>,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Step 1 of the upload flow (phase-03-videos/TD-02): reserve the video row
   * and hand the client a presigned PUT URL so the bytes never cross the API.
   */
  async createUploadIntent(
    userId: string,
    dto: CreateUploadIntentDto,
  ): Promise<UploadIntentResponseDto> {
    const channel = await this.channels.findOne({ where: { user_id: userId } });
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const videoUrlId = await this.generateUniqueVideoUrlId();
    const storageKey = this.storage.buildVideoObjectKey(channel.id, videoUrlId);

    const video = await this.videos.save(
      this.videos.create({
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        video_url_id: videoUrlId,
        storage_key: storageKey,
      }),
    );

    const uploadUrl = await this.storage.createPresignedUploadUrl(storageKey);

    return {
      id: video.id,
      video_url_id: video.video_url_id,
      status: video.status,
      upload_url: uploadUrl,
      storage_key: storageKey,
      expires_in: this.config.presignedUrlExpirationSeconds,
    };
  }

  /**
   * Step 2 of the upload flow: the client confirms the PUT finished, the API
   * verifies the object really exists and enqueues the processing job
   * (phase-03-videos/TD-01, TD-06).
   */
  async completeUpload(
    userId: string,
    videoId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideoById(userId, videoId);

    if (video.status === VideoStatus.PROCESSING) {
      throw new InvalidVideoStateException(
        'Video upload has already been completed and is being processed',
      );
    }
    if (video.status === VideoStatus.READY) {
      throw new InvalidVideoStateException(
        'Video has already been processed successfully',
      );
    }
    if (!video.storage_key) {
      throw new VideoFileMissingException();
    }

    const uploaded = await this.storage.objectExists(video.storage_key);
    if (!uploaded) {
      throw new VideoFileMissingException();
    }

    video.status = VideoStatus.PROCESSING;
    video.processing_error = null;
    const saved = await this.videos.save(video);

    await this.queue.add(PROCESS_VIDEO_JOB, {
      videoId: saved.id,
      storageKey: saved.storage_key as string,
    });

    this.logger.log(`Enqueued processing job for video ${saved.id}`);

    return this.toResponse(saved);
  }

  async findOwnedVideos(userId: string): Promise<VideoResponseDto[]> {
    const channel = await this.channels.findOne({ where: { user_id: userId } });
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const videos = await this.videos.find({
      where: { channel_id: channel.id },
      order: { created_at: 'DESC' },
    });

    return Promise.all(videos.map((video) => this.toResponse(video)));
  }

  async findOwnedVideoDetails(
    userId: string,
    videoId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideoById(userId, videoId);
    return this.toResponse(video);
  }

  /**
   * Playback is public: any client holding the short URL id gets a short-lived
   * presigned GET URL. The storage serves Range requests, so playback starts
   * immediately without the API proxying bytes (phase-03-videos/TD-05).
   */
  async getStreamUrl(videoUrlId: string): Promise<string> {
    const video = await this.findReadyVideoByUrlId(videoUrlId);
    return this.storage.createPresignedStreamUrl(video.storage_key as string);
  }

  async getDownloadUrl(videoUrlId: string): Promise<string> {
    const video = await this.findReadyVideoByUrlId(videoUrlId);
    return this.storage.createPresignedDownloadUrl(
      video.storage_key as string,
      `${video.title}.mp4`,
    );
  }

  private async findReadyVideoByUrlId(videoUrlId: string): Promise<Video> {
    const video = await this.videos.findOne({
      where: { video_url_id: videoUrlId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findOwnedVideoById(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videos.findOne({
      where: { id: videoId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new NotVideoOwnerException();
    }
    return video;
  }

  private async generateUniqueVideoUrlId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateVideoUrlId();
      const existing = await this.videos.findOne({
        where: { video_url_id: candidate },
        select: { id: true },
      });
      if (!existing) {
        return candidate;
      }
    }
    throw new Error('Could not generate a unique video_url_id');
  }

  private async toResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.createPresignedStreamUrl(video.thumbnail_key)
      : null;

    return {
      id: video.id,
      video_url_id: video.video_url_id,
      title: video.title,
      status: video.status,
      duration: video.duration,
      thumbnail_url: thumbnailUrl,
      metadata: video.metadata,
      processing_error: video.processing_error,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }
}
