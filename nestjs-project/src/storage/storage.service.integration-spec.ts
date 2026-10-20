import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

/**
 * Integration test against the real MinIO service defined in compose.yaml.
 * Presigned URLs are exercised end-to-end with fetch (no mocks).
 */
describe('StorageService (integration)', () => {
  let service: StorageService;
  let tempDir: string;
  const objectKey = `videos/integration-test/${Date.now()}.txt`;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'storage-int-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
    await service.ensureBucket();
  });

  afterAll(async () => {
    try {
      await service.removeObject(objectKey);
    } catch {
      // object may already be gone
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uploads and downloads a file through the storage client', async () => {
    const sourcePath = join(tempDir, 'source.txt');
    const targetPath = join(tempDir, 'target.txt');
    await writeFile(sourcePath, 'streamtube-integration');

    await service.uploadFile(objectKey, sourcePath, 'text/plain');

    await expect(service.objectExists(objectKey)).resolves.toBe(true);

    await service.downloadToFile(objectKey, targetPath);
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(
      'streamtube-integration',
    );
  });

  it('returns a presigned upload URL that accepts a direct PUT', async () => {
    const directKey = `videos/integration-test/direct-${Date.now()}.txt`;
    const uploadUrl = await service.createPresignedUploadUrl(directKey);

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: 'uploaded-directly',
    });

    expect(putResponse.status).toBe(200);
    await expect(service.objectExists(directKey)).resolves.toBe(true);

    await service.removeObject(directKey);
  });

  it('returns a presigned stream URL that supports HTTP Range requests', async () => {
    const streamUrl = await service.createPresignedStreamUrl(objectKey);

    const rangeResponse = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-4' },
    });

    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toMatch(/^bytes 0-4\//);
    await expect(rangeResponse.text()).resolves.toBe('strea');
  });

  it('returns a presigned download URL with attachment disposition', async () => {
    const downloadUrl = await service.createPresignedDownloadUrl(
      objectKey,
      'meu video.txt',
    );

    const response = await fetch(downloadUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="meu-video.txt"',
    );
  });
});
