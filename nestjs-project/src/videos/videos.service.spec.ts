import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE, PROCESS_VIDEO_JOB } from './videos.constants';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  NotVideoOwnerException,
  VideoFileMissingException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';
import { generateVideoUrlId, VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID } as Channel;

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channel_id: CHANNEL.id,
    title: 'My video',
    status: VideoStatus.DRAFT,
    video_url_id: 'abcdefghij1',
    storage_key: 'videos/channel-1/abcdefghij1',
    thumbnail_key: null,
    duration: null,
    metadata: null,
    processing_error: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    channel: CHANNEL,
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  let videosRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let channelsRepo: { findOne: jest.Mock };
  let queue: { add: jest.Mock };
  let storage: {
    buildVideoObjectKey: jest.Mock;
    createPresignedUploadUrl: jest.Mock;
    createPresignedStreamUrl: jest.Mock;
    createPresignedDownloadUrl: jest.Mock;
    objectExists: jest.Mock;
  };

  beforeEach(async () => {
    videosRepo = {
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((data: Partial<Video>) => data),
      save: jest
        .fn()
        .mockImplementation((data: Partial<Video>) =>
          Promise.resolve(buildVideo(data)),
        ),
    };
    channelsRepo = { findOne: jest.fn().mockResolvedValue(CHANNEL) };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    storage = {
      buildVideoObjectKey: jest
        .fn()
        .mockImplementation(
          (channelId: string, urlId: string) => `videos/${channelId}/${urlId}`,
        ),
      createPresignedUploadUrl: jest.fn().mockResolvedValue('http://upload'),
      createPresignedStreamUrl: jest.fn().mockResolvedValue('http://stream'),
      createPresignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('http://download'),
      objectExists: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videosRepo },
        { provide: getRepositoryToken(Channel), useValue: channelsRepo },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: StorageService, useValue: storage },
        {
          provide: storageConfig.KEY,
          useValue: { presignedUrlExpirationSeconds: 3600 },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('generateVideoUrlId', () => {
    it('generates 11-character URL-safe ids', () => {
      const id = generateVideoUrlId();
      expect(id).toHaveLength(11);
      expect(id).toMatch(/^[0-9A-Za-z]{11}$/);
    });

    it('generates distinct ids across calls', () => {
      const ids = new Set(Array.from({ length: 200 }, generateVideoUrlId));
      expect(ids.size).toBe(200);
    });
  });

  describe('createUploadIntent', () => {
    it('creates a draft video and returns a presigned upload URL', async () => {
      const result = await service.createUploadIntent(USER_ID, {
        title: 'My video',
      });

      expect(videosRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: CHANNEL.id,
          title: 'My video',
          status: VideoStatus.DRAFT,
        }),
      );
      expect(result.upload_url).toBe('http://upload');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.expires_in).toBe(3600);
      expect(result.storage_key).toBe(
        `videos/${CHANNEL.id}/${result.video_url_id}`,
      );
      expect(result.video_url_id).toHaveLength(11);
    });

    it('retries generation when the url id already exists', async () => {
      videosRepo.findOne
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);

      await service.createUploadIntent(USER_ID, { title: 'My video' });

      expect(videosRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it('fails when the user has no channel', async () => {
      channelsRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createUploadIntent(USER_ID, { title: 'My video' }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });
  });

  describe('completeUpload', () => {
    it('moves the video to processing and enqueues a job', async () => {
      videosRepo.findOne.mockResolvedValueOnce(buildVideo());

      const result = await service.completeUpload(USER_ID, 'video-1');

      expect(storage.objectExists).toHaveBeenCalledWith(
        'videos/channel-1/abcdefghij1',
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).toHaveBeenCalledWith(PROCESS_VIDEO_JOB, {
        videoId: 'video-1',
        storageKey: 'videos/channel-1/abcdefghij1',
      });
    });

    it('fails when the uploaded object is missing', async () => {
      videosRepo.findOne.mockResolvedValueOnce(buildVideo());
      storage.objectExists.mockResolvedValueOnce(false);

      await expect(
        service.completeUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoFileMissingException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fails when the video does not exist', async () => {
      videosRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.completeUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('fails when the video belongs to another user', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({
          channel: { id: 'channel-2', user_id: 'other-user' } as Channel,
        }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(NotVideoOwnerException);
    });

    it('rejects a second completion while processing', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });

    it('rejects completion of an already ready video', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({ status: VideoStatus.READY }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });

    it('allows retrying after a processing error', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({
          status: VideoStatus.ERROR,
          processing_error: 'ffprobe failed',
        }),
      );

      const result = await service.completeUpload(USER_ID, 'video-1');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.processing_error).toBeNull();
      expect(queue.add).toHaveBeenCalled();
    });
  });

  describe('findOwnedVideos', () => {
    it('lists videos with presigned thumbnail URLs', async () => {
      videosRepo.find.mockResolvedValueOnce([
        buildVideo({
          status: VideoStatus.READY,
          duration: 120,
          thumbnail_key: 'thumbnails/channel-1/abcdefghij1.jpg',
        }),
      ]);

      const result = await service.findOwnedVideos(USER_ID);

      expect(videosRepo.find).toHaveBeenCalledWith({
        where: { channel_id: CHANNEL.id },
        order: { created_at: 'DESC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].thumbnail_url).toBe('http://stream');
      expect(result[0].duration).toBe(120);
    });

    it('omits the thumbnail URL when no thumbnail exists', async () => {
      videosRepo.find.mockResolvedValueOnce([buildVideo()]);

      const result = await service.findOwnedVideos(USER_ID);

      expect(result[0].thumbnail_url).toBeNull();
      expect(storage.createPresignedStreamUrl).not.toHaveBeenCalled();
    });
  });

  describe('getStreamUrl', () => {
    it('returns a presigned stream URL for ready videos', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({ status: VideoStatus.READY }),
      );

      await expect(service.getStreamUrl('abcdefghij1')).resolves.toBe(
        'http://stream',
      );
      expect(storage.createPresignedStreamUrl).toHaveBeenCalledWith(
        'videos/channel-1/abcdefghij1',
      );
    });

    it('fails when the video is still processing', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.getStreamUrl('abcdefghij1')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });

    it('fails when the video does not exist', async () => {
      videosRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getStreamUrl('missing0001')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('returns a presigned download URL using the video title', async () => {
      videosRepo.findOne.mockResolvedValueOnce(
        buildVideo({ status: VideoStatus.READY, title: 'Holiday trip' }),
      );

      await expect(service.getDownloadUrl('abcdefghij1')).resolves.toBe(
        'http://download',
      );
      expect(storage.createPresignedDownloadUrl).toHaveBeenCalledWith(
        'videos/channel-1/abcdefghij1',
        'Holiday trip.mp4',
      );
    });
  });
});
