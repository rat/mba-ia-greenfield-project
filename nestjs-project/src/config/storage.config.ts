import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'streamtube',
  secretKey: process.env.MINIO_SECRET_KEY || 'streamtube123',
  bucket: process.env.MINIO_BUCKET || 'streamtube',
  publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT || 'localhost',
  publicPort: parseInt(
    process.env.MINIO_PUBLIC_PORT || process.env.MINIO_PORT || '9000',
    10,
  ),
  presignedUrlExpirationSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
