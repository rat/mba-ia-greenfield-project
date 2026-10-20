import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

/**
 * Exercises the real FFmpeg pipeline (ffprobe + thumbnail) against a small
 * generated sample video, using the real MinIO and Postgres services.
 *
 * The fixture is created by `test/fixtures/sample.mp4` and only requires
 * ffmpeg/ffprobe to be available, which is the case inside the worker image.
 */
const SAMPLE_VIDEO = join(process.cwd(), 'test/fixtures/sample.mp4');

describe('VideoProcessingService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: [User, Channel, RefreshToken, VerificationToken, Video],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingService],
    }).compile();

    await moduleRef.init();

    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker-int-${Date.now()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Worker channel',
        nickname: `worker-int-${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  it('probes a real video file and reports duration and codecs', async () => {
    const probe = await service.probe(SAMPLE_VIDEO);

    expect(probe.durationSeconds).toBeGreaterThan(4);
    expect(probe.durationSeconds).toBeLessThan(6);
    expect(probe.metadata.width).toBe(320);
    expect(probe.metadata.height).toBe(240);
    expect(probe.metadata.video_codec).toBe('h264');
    expect(probe.metadata.audio_codec).toBe('aac');
  });

  it('processes an uploaded video end to end and marks it ready', async () => {
    const videoUrlId = `int${Date.now().toString(36)}`.slice(0, 11);
    const storageKey = storage.buildVideoObjectKey(channel.id, videoUrlId);
    await storage.uploadFile(storageKey, SAMPLE_VIDEO, 'video/mp4');

    const video = await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'Real processing',
        status: VideoStatus.PROCESSING,
        video_url_id: videoUrlId,
        storage_key: storageKey,
      }),
    );

    await service.process({ videoId: video.id, storageKey });

    const processed = await videos.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration).toBe(5);
    expect(processed.processing_error).toBeNull();
    expect(processed.thumbnail_key).toBe(
      `thumbnails/${channel.id}/${videoUrlId}.jpg`,
    );
    expect(processed.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
    });
    expect(processed.metadata?.size_bytes).toBe(
      (await stat(SAMPLE_VIDEO)).size,
    );

    await expect(
      storage.objectExists(processed.thumbnail_key as string),
    ).resolves.toBe(true);

    const thumbnailUrl = await storage.createPresignedStreamUrl(
      processed.thumbnail_key as string,
    );
    const response = await fetch(thumbnailUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');

    await storage.removeObject(storageKey);
    await storage.removeObject(processed.thumbnail_key as string);
  });

  it('marks the video as error when the stored object is not a valid video', async () => {
    const videoUrlId = `bad${Date.now().toString(36)}`.slice(0, 11);
    const storageKey = storage.buildVideoObjectKey(channel.id, videoUrlId);
    await storage.uploadFile(
      storageKey,
      join(process.cwd(), 'package.json'),
      'video/mp4',
    );

    const video = await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'Corrupt upload',
        status: VideoStatus.PROCESSING,
        video_url_id: videoUrlId,
        storage_key: storageKey,
      }),
    );

    await expect(
      service.process({ videoId: video.id, storageKey }),
    ).rejects.toThrow();

    const processed = await videos.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.ERROR);
    expect(processed.processing_error).toBeTruthy();
    expect(processed.thumbnail_key).toBeNull();

    await storage.removeObject(storageKey);
  });
});
