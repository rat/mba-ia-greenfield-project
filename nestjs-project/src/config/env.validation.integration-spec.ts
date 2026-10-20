import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  MINIO_ACCESS_KEY: 'streamtube',
  MINIO_SECRET_KEY: 'streamtube123',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue variables', () => {
  it('should require the storage credentials', () => {
    const { error } = envValidationSchema.validate(
      {
        DB_USERNAME: 'user',
        DB_PASSWORD: 'pass',
        DB_NAME: 'db',
        JWT_SECRET: 'secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      },
      { allowUnknown: true, abortEarly: false },
    );

    expect(error).toBeDefined();
    expect(error!.message).toContain('MINIO_ACCESS_KEY');
    expect(error!.message).toContain('MINIO_SECRET_KEY');
  });

  it('should apply Compose-friendly defaults for Redis and MinIO', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.MINIO_ENDPOINT).toBe('minio');
    expect(value.MINIO_PORT).toBe(9000);
    expect(value.MINIO_USE_SSL).toBe('false');
    expect(value.MINIO_BUCKET).toBe('streamtube');
    expect(value.PRESIGNED_URL_EXPIRATION_SECONDS).toBe(3600);
  });

  it('should reject a non-numeric presigned URL expiration', () => {
    const { error } = validate({
      PRESIGNED_URL_EXPIRATION_SECONDS: 'not-a-number',
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('PRESIGNED_URL_EXPIRATION_SECONDS');
  });

  it('should reject an invalid MINIO_USE_SSL value', () => {
    const { error } = validate({ MINIO_USE_SSL: 'yes' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('MINIO_USE_SSL');
  });
});
