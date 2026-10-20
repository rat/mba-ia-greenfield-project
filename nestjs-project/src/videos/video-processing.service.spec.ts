import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoNotFoundException } from './videos.exceptions';

// `var` so the declarations are hoisted above the `jest.mock` factory, which
// jest itself hoists to the top of the file.
/* eslint-disable no-var */
var ffprobeMock: jest.Mock;
var screenshotsMock: jest.Mock;
/* eslint-enable no-var */

jest.mock('fluent-ffmpeg', () => {
  ffprobeMock = jest.fn();
  screenshotsMock = jest.fn();

  const factory = jest.fn(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const chain = {
      on(event: string, handler: (arg?: unknown) => void) {
        handlers[event] = handler;
        return chain;
      },
      screenshots(options: unknown) {
        screenshotsMock(options);
        const failure = screenshotsMock.mock.results.at(-1)?.value as
          | Error
          | undefined;
        setImmediate(() => {
          if (failure instanceof Error) {
            handlers.error?.(failure);
          } else {
            handlers.end?.();
          }
        });
        return chain;
      },
    };
    return chain;
  }) as unknown as { ffprobe: typeof ffprobeMock };

  factory.ffprobe = ffprobeMock;
  return { __esModule: true, default: factory, ffprobe: ffprobeMock };
});

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/video-work'),
  rm: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 2048 }),
}));

const PROBE_DATA = {
  format: {
    duration: '125.4',
    bit_rate: '1490000',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videosRepo: { findOne: jest.Mock; update: jest.Mock };
  let storage: {
    downloadToFile: jest.Mock;
    uploadFile: jest.Mock;
    buildThumbnailObjectKey: jest.Mock;
  };

  const video = {
    id: 'video-1',
    channel_id: 'channel-1',
    video_url_id: 'abcdefghij1',
    status: VideoStatus.PROCESSING,
  } as Video;

  beforeEach(async () => {
    jest.clearAllMocks();
    ffprobeMock.mockImplementation(
      (_path: string, cb: (err: unknown, data: unknown) => void) =>
        cb(null, PROBE_DATA),
    );
    screenshotsMock.mockReturnValue(undefined);

    videosRepo = {
      findOne: jest.fn().mockResolvedValue(video),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      buildThumbnailObjectKey: jest
        .fn()
        .mockReturnValue('thumbnails/channel-1/abcdefghij1.jpg'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videosRepo },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(VideoProcessingService);
  });

  it('downloads, probes, thumbnails and marks the video as ready', async () => {
    await service.process({
      videoId: 'video-1',
      storageKey: 'videos/channel-1/abcdefghij1',
    });

    expect(storage.downloadToFile).toHaveBeenCalledWith(
      'videos/channel-1/abcdefghij1',
      '/tmp/video-work/source',
    );
    expect(screenshotsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamps: [62.7],
        filename: 'thumbnail.jpg',
        folder: '/tmp/video-work',
      }),
    );
    expect(storage.uploadFile).toHaveBeenCalledWith(
      'thumbnails/channel-1/abcdefghij1.jpg',
      '/tmp/video-work/thumbnail.jpg',
      'image/jpeg',
    );
    expect(videosRepo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      {
        status: VideoStatus.READY,
        duration: 125,
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          bit_rate: 1490000,
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          size_bytes: 2048,
        },
        thumbnail_key: 'thumbnails/channel-1/abcdefghij1.jpg',
        processing_error: null,
      },
    );
  });

  it('marks the video as error and rethrows when ffprobe fails', async () => {
    ffprobeMock.mockImplementation(
      (_path: string, cb: (err: unknown, data: unknown) => void) =>
        cb(new Error('Invalid data found when processing input'), null),
    );

    await expect(
      service.process({
        videoId: 'video-1',
        storageKey: 'videos/channel-1/abcdefghij1',
      }),
    ).rejects.toThrow('Invalid data found when processing input');

    expect(videosRepo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      {
        status: VideoStatus.ERROR,
        processing_error: 'Invalid data found when processing input',
      },
    );
  });

  it('marks the video as error when the duration cannot be determined', async () => {
    ffprobeMock.mockImplementation(
      (_path: string, cb: (err: unknown, data: unknown) => void) =>
        cb(null, { format: {}, streams: [] }),
    );

    await expect(
      service.process({
        videoId: 'video-1',
        storageKey: 'videos/channel-1/abcdefghij1',
      }),
    ).rejects.toThrow('Could not determine the video duration');

    expect(videosRepo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      expect.objectContaining({ status: VideoStatus.ERROR }),
    );
  });

  it('marks the video as error when the download fails', async () => {
    storage.downloadToFile.mockRejectedValueOnce(new Error('storage down'));

    await expect(
      service.process({
        videoId: 'video-1',
        storageKey: 'videos/channel-1/abcdefghij1',
      }),
    ).rejects.toThrow('storage down');

    expect(videosRepo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { status: VideoStatus.ERROR, processing_error: 'storage down' },
    );
  });

  it('marks the video as error when thumbnail generation fails', async () => {
    screenshotsMock.mockReturnValue(new Error('thumbnail failed'));

    await expect(
      service.process({
        videoId: 'video-1',
        storageKey: 'videos/channel-1/abcdefghij1',
      }),
    ).rejects.toThrow('thumbnail failed');

    expect(videosRepo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { status: VideoStatus.ERROR, processing_error: 'thumbnail failed' },
    );
  });

  it('fails when the video row no longer exists', async () => {
    videosRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      service.process({
        videoId: 'missing',
        storageKey: 'videos/channel-1/missing',
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    expect(storage.downloadToFile).not.toHaveBeenCalled();
  });
});
