import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { cleanAllTables } from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import {
  InvalidVideoStateException,
  VideoFileMissingException,
  VideoNotReadyException,
} from './videos.exceptions';
import { VideosService } from './videos.service';
import { VideoProcessor } from './video.processor';
import { VideoProcessingService } from './video-processing.service';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;
  let storage: StorageService;
  let tempDir: string;
  let user: User;
  let channel: Channel;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'videos-int-'));

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
        TypeOrmModule.forFeature([Video, Channel]),
        StorageModule,
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideosService, VideoProcessor, VideoProcessingService],
    }).compile();

    await moduleRef.init();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );

    // Mock processor to avoid race conditions during queue assertions
    const processor = moduleRef.get(VideoProcessor);
    jest.spyOn(processor, 'process').mockImplementation(async () => {});
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await moduleRef.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });

    user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `videos-int-${Date.now()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Integration channel',
        nickname: `videos-int-${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  it('creates a draft video and a working presigned upload URL', async () => {
    const intent = await service.createUploadIntent(user.id, {
      title: 'Integration upload',
    });

    expect(intent.status).toBe(VideoStatus.DRAFT);
    expect(intent.video_url_id).toHaveLength(11);
    expect(intent.storage_key).toBe(
      `videos/${channel.id}/${intent.video_url_id}`,
    );

    const putResponse = await fetch(intent.upload_url, {
      method: 'PUT',
      body: 'fake-video-bytes',
    });
    expect(putResponse.status).toBe(200);

    await expect(storage.objectExists(intent.storage_key)).resolves.toBe(true);

    const persisted = await videos.findOneByOrFail({ id: intent.id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.channel_id).toBe(channel.id);

    await storage.removeObject(intent.storage_key);
  });

  it('rejects completion when the object was never uploaded', async () => {
    const intent = await service.createUploadIntent(user.id, {
      title: 'Never uploaded',
    });

    await expect(
      service.completeUpload(user.id, intent.id),
    ).rejects.toBeInstanceOf(VideoFileMissingException);

    await expect(queue.getWaitingCount()).resolves.toBe(0);
  });

  it('enqueues a real job after a successful upload', async () => {
    const intent = await service.createUploadIntent(user.id, {
      title: 'Enqueued video',
    });

    const sourcePath = join(tempDir, 'upload.bin');
    await writeFile(sourcePath, 'fake-video-bytes');
    await storage.uploadFile(intent.storage_key, sourcePath, 'video/mp4');

    const result = await service.completeUpload(user.id, intent.id);
    expect(result.status).toBe(VideoStatus.PROCESSING);

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
    expect({ ...waiting[0].data }).toEqual({
      videoId: intent.id,
      storageKey: intent.storage_key,
    });

    await expect(
      service.completeUpload(user.id, intent.id),
    ).rejects.toBeInstanceOf(InvalidVideoStateException);

    await storage.removeObject(intent.storage_key);
  });

  it('lists the videos of the channel with presigned thumbnail URLs', async () => {
    const first = await service.createUploadIntent(user.id, { title: 'One' });
    const second = await service.createUploadIntent(user.id, { title: 'Two' });

    await videos.update(
      { id: second.id },
      {
        status: VideoStatus.READY,
        duration: 42,
        thumbnail_key: `thumbnails/${channel.id}/${second.video_url_id}.jpg`,
      },
    );

    const listed = await service.findOwnedVideos(user.id);

    expect(listed).toHaveLength(2);
    const ready = listed.find((v) => v.id === second.id);
    const draft = listed.find((v) => v.id === first.id);
    expect(ready?.duration).toBe(42);
    expect(ready?.thumbnail_url).toContain('thumbnails/');
    expect(draft?.thumbnail_url).toBeNull();
  });

  it('returns a streamable presigned URL only for ready videos', async () => {
    const intent = await service.createUploadIntent(user.id, {
      title: 'Streamable',
    });

    await expect(
      service.getStreamUrl(intent.video_url_id),
    ).rejects.toBeInstanceOf(VideoNotReadyException);

    const sourcePath = join(tempDir, 'stream.bin');
    await writeFile(sourcePath, 'streamable-content');
    await storage.uploadFile(intent.storage_key, sourcePath, 'video/mp4');
    await videos.update({ id: intent.id }, { status: VideoStatus.READY });

    const streamUrl = await service.getStreamUrl(intent.video_url_id);
    const rangeResponse = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-3' },
    });

    expect(rangeResponse.status).toBe(206);
    await expect(rangeResponse.text()).resolves.toBe('stre');

    const downloadUrl = await service.getDownloadUrl(intent.video_url_id);
    const downloadResponse = await fetch(downloadUrl);
    expect(downloadResponse.headers.get('content-disposition')).toBe(
      'attachment; filename="Streamable.mp4"',
    );

    await storage.removeObject(intent.storage_key);
  });
});
