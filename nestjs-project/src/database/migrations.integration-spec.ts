import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1786463010493 } from './migrations/1786463010493-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1786463010493,
        ],
      },
    );

    await dataSource.initialize();

    // Dropped sequentially: parallel DROP TABLE statements deadlock once the
    // videos -> channels foreign key exists.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Enum types survive DROP TABLE, so drop them explicitly to guarantee the
    // migrations run against a clean schema.
    for (const enumType of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "${enumType}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The last test undoes the final migration, leaving the videos table
    // missing. Re-apply so the shared DB is fully migrated for other suites.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos table with its constraints and index', async () => {
    const columns = await dataSource.query<
      { column_name: string; is_nullable: string; data_type: string }[]
    >(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_name = 'videos'
       ORDER BY column_name`,
    );

    expect(columns.map((c) => c.column_name)).toEqual([
      'channel_id',
      'created_at',
      'duration',
      'id',
      'metadata',
      'processing_error',
      'status',
      'storage_key',
      'thumbnail_key',
      'title',
      'updated_at',
      'video_url_id',
    ]);

    const uniqueConstraints = await dataSource.query<{ column_name: string }[]>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'videos' AND tc.constraint_type = 'UNIQUE'`,
    );
    expect(uniqueConstraints.map((c) => c.column_name)).toEqual([
      'video_url_id',
    ]);

    const foreignKeys = await dataSource.query<
      { column_name: string; foreign_table_name: string; delete_rule: string }[]
    >(
      `SELECT kcu.column_name,
              ccu.table_name AS foreign_table_name,
              rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'videos' AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(foreignKeys).toEqual([
      {
        column_name: 'channel_id',
        foreign_table_name: 'channels',
        delete_rule: 'CASCADE',
      },
    ]);

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'videos'`,
    );
    expect(indexes.some((i) => i.indexdef.includes('(status)'))).toBe(true);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });
});
