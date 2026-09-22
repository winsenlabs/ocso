import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { BlobStore } from '@ocso/blob';
import { z } from 'zod';
import { Public } from '../../common/decorators.js';
import { BLOB_STORE } from '../../infrastructure/tokens.js';

const SignedQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });
type SignedQuery = z.infer<typeof SignedQuery>;

/**
 * Signed media downloads for blob stores that serve their links through OCSO
 * (the local driver, ADR-011). The signature is the authorization; URLs expire
 * in minutes. Stores with their own signed URLs (S3 presigning) have no
 * `verifySignedGet`, so this route refuses every request for them.
 */
@Controller('blobs')
export class BlobsController {
  constructor(@Inject(BLOB_STORE) private readonly blobs: BlobStore) {}

  @Get('*path')
  @Public()
  async download(@Req() req: Request, @Query({ schema: SignedQuery }) q: SignedQuery, @Res() res: Response): Promise<void> {
    const key = decodeURIComponent(req.path.replace(/^\/blobs\//, ''));
    if (!this.blobs.verifySignedGet?.(key, q.exp, q.sig, Math.floor(Date.now() / 1000))) {
      res.status(403).json({ error: { category: 'authorization', code: 'invalid_signature', message: 'Link expired or invalid' } });
      return;
    }
    const obj = await this.blobs.get(key);
    res
      .status(200)
      .setHeader('content-type', obj.contentType)
      .setHeader('cache-control', 'private, max-age=300')
      .setHeader('x-content-type-options', 'nosniff')
      .setHeader('content-disposition', obj.contentType.startsWith('image/') ? 'inline' : 'attachment')
      .send(Buffer.from(obj.data));
  }
}
