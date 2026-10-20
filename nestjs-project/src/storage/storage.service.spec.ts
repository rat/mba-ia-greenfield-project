import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { sanitizeFileName, StorageService } from './storage.service';

interface MinioClientMock {
  bucketExists: jest.Mock;
  makeBucket: jest.Mock;
  presignedPutObject: jest.Mock;
  presignedGetObject: jest.Mock;
  statObject: jest.Mock;
  getObject: jest.Mock;
  fPutObject: jest.Mock;
  removeObject: jest.Mock;
}

const clients: MinioClientMock[] = [];

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => {
    const client: MinioClientMock = {
      bucketExists: jest.fn().mockResolvedValue(true),
      makeBucket: jest.fn().mockResolvedValue(undefined),
      presignedPutObject: jest.fn().mockResolvedValue('http://upload-url'),
      presignedGetObject: jest.fn().mockResolvedValue('http://get-url'),
      statObject: jest.fn().mockResolvedValue({ size: 10 }),
      getObject: jest.fn(),
      fPutObject: jest.fn().mockResolvedValue(undefined),
      removeObject: jest.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client;
  }),
}));

const config = {
  endpoint: 'minio',
  port: 9000,
  useSSL: false,
  accessKey: 'streamtube',
  secretKey: 'streamtube123',
  bucket: 'streamtube',
  publicEndpoint: 'localhost',
  publicPort: 9000,
  presignedUrlExpirationSeconds: 3600,
};

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    clients.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  it('exposes the configured bucket', () => {
    expect(service.bucket).toBe('streamtube');
  });

  it('builds deterministic object keys scoped by channel', () => {
    expect(service.buildVideoObjectKey('channel-1', 'abc123XYZ98')).toBe(
      'videos/channel-1/abc123XYZ98',
    );
    expect(service.buildThumbnailObjectKey('channel-1', 'abc123XYZ98')).toBe(
      'thumbnails/channel-1/abc123XYZ98.jpg',
    );
  });

  it('creates a presigned upload URL against the public endpoint', async () => {
    const url = await service.createPresignedUploadUrl('videos/c/v');

    expect(url).toBe('http://upload-url');
    // clients[0] = internal client, clients[1] = public client
    expect(clients[1].presignedPutObject).toHaveBeenCalledWith(
      'streamtube',
      'videos/c/v',
      3600,
    );
  });

  it('creates a presigned streaming URL without content-disposition', async () => {
    await service.createPresignedStreamUrl('videos/c/v');

    expect(clients[1].presignedGetObject).toHaveBeenCalledWith(
      'streamtube',
      'videos/c/v',
      3600,
    );
  });

  it('creates a presigned download URL forcing attachment disposition', async () => {
    await service.createPresignedDownloadUrl('videos/c/v', 'Meu Vídeo!.mp4');

    expect(clients[1].presignedGetObject).toHaveBeenCalledWith(
      'streamtube',
      'videos/c/v',
      3600,
      {
        'response-content-disposition': 'attachment; filename="Meu-Video.mp4"',
      },
    );
  });

  it('reports object existence based on statObject', async () => {
    await expect(service.objectExists('videos/c/v')).resolves.toBe(true);

    clients[0].statObject.mockRejectedValueOnce(new Error('not found'));
    await expect(service.objectExists('videos/c/missing')).resolves.toBe(false);
  });

  it('creates the bucket when it does not exist', async () => {
    clients[0].bucketExists.mockResolvedValueOnce(false);

    await service.ensureBucket();

    expect(clients[0].makeBucket).toHaveBeenCalledWith('streamtube');
  });

  describe('sanitizeFileName', () => {
    it('strips diacritics and unsafe characters', () => {
      expect(sanitizeFileName('Ação: o "vídeo"/final.mp4')).toBe(
        'Acao-o-videofinal.mp4',
      );
    });

    it('falls back to a default name when nothing is left', () => {
      expect(sanitizeFileName('***')).toBe('video');
    });
  });
});
