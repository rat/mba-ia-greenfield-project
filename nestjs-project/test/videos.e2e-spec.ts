import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VideoProcessingService } from '../src/videos/video-processing.service';
import { VideoProcessor } from '../src/videos/video.processor';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../src/videos/videos.constants';

const SAMPLE_VIDEO = join(process.cwd(), 'test/fixtures/sample.mp4');

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;
  let storage: StorageService;
  let processing: VideoProcessingService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    // In testing, we might want to prevent the worker from picking up jobs
    // so we can assert they are in the queue.
    const worker = moduleFixture.get(VideoProcessor);
    jest.spyOn(worker, 'process').mockImplementation(async () => {
      // Do nothing, keep job in queue/processing state for assertion
    });

    dataSource = moduleFixture.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    processing = moduleFixture.get(VideoProcessingService);
    queue = moduleFixture.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const mailService = app.get(MailService);
    let capturedToken = '';

    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, token: string) => {
        capturedToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return login.body.access_token as string;
  }

  it('walks through the whole journey: intent, upload, processing, streaming and download', async () => {
    const accessToken = await registerConfirmAndLogin(
      `journey-${Date.now()}@example.com`,
    );

    // 1) Upload intent
    const intentResponse = await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'My e2e video' })
      .expect(201);

    const intent = intentResponse.body as {
      id: string;
      video_url_id: string;
      status: string;
      upload_url: string;
      storage_key: string;
      expires_in: number;
    };
    expect(intent.status).toBe(VideoStatus.DRAFT);
    expect(intent.video_url_id).toHaveLength(11);
    expect(intent.expires_in).toBeGreaterThan(0);

    // 2) Direct upload to the object storage with the presigned URL
    const fileBuffer = await readFile(SAMPLE_VIDEO);
    const uploadResponse = await fetch(intent.upload_url, {
      method: 'PUT',
      body: fileBuffer,
      headers: { 'Content-Type': 'video/mp4' },
    });
    expect(uploadResponse.status).toBe(200);

    // 3) Confirm the upload: the API enqueues the processing job
    const completeResponse = await request(app.getHttpServer())
      .post(`/videos/${intent.id}/upload-complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(202);
    expect(completeResponse.body.status).toBe(VideoStatus.PROCESSING);

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);

    // 4) Status polling shows the video still processing
    const processingStatus = await request(app.getHttpServer())
      .get(`/videos/${intent.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(processingStatus.body.status).toBe(VideoStatus.PROCESSING);
    expect(processingStatus.body.duration).toBeNull();

    // 5) Streaming is refused while the video is not ready
    await request(app.getHttpServer())
      .get(`/videos/${intent.video_url_id}/stream`)
      .expect(409)
      .expect((res) => {
        expect(res.body.error).toBe('VIDEO_NOT_READY');
      });

    // 6) Run the worker job (the worker container does the same in real usage)
    await processing.process({
      videoId: intent.id,
      storageKey: intent.storage_key,
    });

    // 7) The video is ready, with duration, metadata and thumbnail
    const readyStatus = await request(app.getHttpServer())
      .get(`/videos/${intent.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(readyStatus.body.status).toBe(VideoStatus.READY);
    expect(readyStatus.body.duration).toBe(5);
    expect(readyStatus.body.thumbnail_url).toContain('thumbnails/');
    expect(readyStatus.body.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
    });

    // 8) Streaming redirects to the presigned URL and supports Range requests
    const streamRedirect = await request(app.getHttpServer())
      .get(`/videos/${intent.video_url_id}/stream`)
      .expect(302);
    const streamUrl = streamRedirect.headers.location;
    expect(streamUrl).toContain(intent.storage_key);

    const rangeResponse = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-length')).toBe('1024');

    // 9) Download redirects to a presigned URL forcing an attachment
    const downloadRedirect = await request(app.getHttpServer())
      .get(`/videos/${intent.video_url_id}/download`)
      .expect(302);
    const downloadResponse = await fetch(downloadRedirect.headers.location);
    expect(downloadResponse.headers.get('content-disposition')).toBe(
      'attachment; filename="My-e2e-video.mp4"',
    );

    // 10) The video shows up in the owner's listing
    const listing = await request(app.getHttpServer())
      .get('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(listing.body).toHaveLength(1);
    expect(listing.body[0].id).toBe(intent.id);

    const persisted = await videos.findOneByOrFail({ id: intent.id });
    await storage.removeObject(persisted.storage_key as string);
    await storage.removeObject(persisted.thumbnail_key as string);
  }, 60000);

  it('marks the video as error when the uploaded file is not a valid video', async () => {
    const accessToken = await registerConfirmAndLogin(
      `broken-${Date.now()}@example.com`,
    );

    const intentResponse = await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Broken upload' })
      .expect(201);
    const intent = intentResponse.body as {
      id: string;
      video_url_id: string;
      storage_key: string;
      upload_url: string;
    };

    await fetch(intent.upload_url, {
      method: 'PUT',
      body: 'this is definitely not a video',
    });

    await request(app.getHttpServer())
      .post(`/videos/${intent.id}/upload-complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(202);

    await expect(
      processing.process({
        videoId: intent.id,
        storageKey: intent.storage_key,
      }),
    ).rejects.toThrow();

    const status = await request(app.getHttpServer())
      .get(`/videos/${intent.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(status.body.status).toBe(VideoStatus.ERROR);
    expect(status.body.processing_error).toBeTruthy();

    await request(app.getHttpServer())
      .get(`/videos/${intent.video_url_id}/stream`)
      .expect(409);

    await storage.removeObject(intent.storage_key);
  }, 60000);

  it('rejects completing an upload that never reached the storage', async () => {
    const accessToken = await registerConfirmAndLogin(
      `missing-${Date.now()}@example.com`,
    );

    const intentResponse = await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Never uploaded' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/videos/${intentResponse.body.id}/upload-complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(422)
      .expect((res) => {
        expect(res.body.error).toBe('VIDEO_FILE_MISSING');
      });

    await expect(queue.getWaitingCount()).resolves.toBe(0);
  });

  it('requires authentication for the owner endpoints', async () => {
    await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .send({ title: 'Anonymous' })
      .expect(401);

    await request(app.getHttpServer()).get('/videos').expect(401);
  });

  it('validates the upload intent payload', async () => {
    const accessToken = await registerConfirmAndLogin(
      `validation-${Date.now()}@example.com`,
    );

    await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);

    await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: '' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'ok', unexpected: 'field' })
      .expect(400);
  });

  it('prevents a user from acting on another user videos', async () => {
    const ownerToken = await registerConfirmAndLogin(
      `owner-${Date.now()}@example.com`,
    );
    const intruderToken = await registerConfirmAndLogin(
      `intruder-${Date.now()}@example.com`,
    );

    const intent = await request(app.getHttpServer())
      .post('/videos/upload-intent')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Private video' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/videos/${intent.body.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403)
      .expect((res) => {
        expect(res.body.error).toBe('NOT_VIDEO_OWNER');
      });

    await request(app.getHttpServer())
      .post(`/videos/${intent.body.id}/upload-complete`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    const intruderListing = await request(app.getHttpServer())
      .get('/videos')
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(200);
    expect(intruderListing.body).toHaveLength(0);
  });

  it('returns 404 for unknown videos', async () => {
    const accessToken = await registerConfirmAndLogin(
      `notfound-${Date.now()}@example.com`,
    );

    await request(app.getHttpServer())
      .get('/videos/2f1e9d7c-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404)
      .expect((res) => {
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      });

    await request(app.getHttpServer())
      .get('/videos/doesnotexis/stream')
      .expect(404);
  });
});
