import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      RefreshToken,
      VerificationToken,
      Video,
    ]);
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `owner-${Date.now()}@example.com`,
        password: 'hash',
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Owner channel',
        nickname: `owner-${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  it('persists a video with draft status by default', async () => {
    const saved = await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'My first video',
        video_url_id: 'abcdefghij1',
      }),
    );

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.storage_key).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_error).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('stores probed metadata as jsonb', async () => {
    const saved = await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'Video with metadata',
        video_url_id: 'metadata001',
        status: VideoStatus.READY,
        duration: 125,
        metadata: {
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          size_bytes: 4096,
        },
      }),
    );

    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.duration).toBe(125);
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      size_bytes: 4096,
    });
  });

  it('rejects duplicated video_url_id values', async () => {
    await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'First',
        video_url_id: 'duplicated1',
      }),
    );

    await expect(
      videos.save(
        videos.create({
          channel_id: channel.id,
          title: 'Second',
          video_url_id: 'duplicated1',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('cascades deletion when the owning channel is removed', async () => {
    await videos.save(
      videos.create({
        channel_id: channel.id,
        title: 'To be cascaded',
        video_url_id: 'cascade0001',
      }),
    );

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    await expect(videos.count()).resolves.toBe(0);
  });

  it('rejects videos pointing to an unknown channel', async () => {
    await expect(
      videos.save(
        videos.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan',
          video_url_id: 'orphan00001',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });
});
