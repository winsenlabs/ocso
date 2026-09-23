import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { assertSafeKey, type BlobObject, type BlobPutInput, type BlobStore } from './contract.js';

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (e.g. SeaweedFS in Compose). */
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  /** SSE-KMS key; bucket default encryption applies when omitted. */
  kmsKeyId?: string | undefined;
  keyPrefix?: string | undefined;
}

/**
 * S3 blob store (ADR-011). The presigning client uses
 * requestChecksumCalculation WHEN_REQUIRED — otherwise presigned URLs embed an
 * empty-body checksum and real uploads fail (research/05 §3).
 */
export class S3BlobStore implements BlobStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(private readonly options: S3BlobStoreOptions, client?: S3Client) {
    const base = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    };
    this.client = client ?? new S3Client(base);
    this.presignClient = new S3Client({ ...base, requestChecksumCalculation: 'WHEN_REQUIRED' });
  }

  private objectKey(key: string): string {
    assertSafeKey(key);
    return this.options.keyPrefix ? `${this.options.keyPrefix.replace(/\/$/, '')}/${key}` : key;
  }

  async put(input: BlobPutInput): Promise<BlobObject> {
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.objectKey(input.key),
        Body: input.data,
        ContentType: input.contentType,
        Metadata: { sha256, retention: input.retention ?? 'CONVERSATION_MEDIA' },
        // Lifecycle rules can match tags but not metadata: TEMP objects expire via the bucket rule.
        ...(input.retention === 'TEMP' ? { Tagging: 'ocso-retention=TEMP' } : {}),
        ...(this.options.kmsKeyId
          ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: this.options.kmsKeyId }
          : {}),
      }),
    );
    return { key: input.key, contentType: input.contentType, sizeBytes: input.data.byteLength, sha256 };
  }

  async get(key: string): Promise<{ data: Uint8Array; contentType: string; sizeBytes: number }> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
    const data = await out.Body!.transformToByteArray();
    return { data, contentType: out.ContentType ?? 'application/octet-stream', sizeBytes: data.byteLength };
  }

  async head(key: string): Promise<{ contentType: string; sizeBytes: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
      return { contentType: out.ContentType ?? 'application/octet-stream', sizeBytes: out.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }));
  }

  signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
      { expiresIn: ttlSeconds },
    );
  }
}
