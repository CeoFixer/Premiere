import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './config.js';

// Where the full film is streamed from. Two options, set on the server only:
//  1. A private S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2...):
//     FILM_S3_BUCKET + FILM_S3_KEY (+ FILM_S3_REGION, FILM_S3_ENDPOINT, keys).
//     Buyers get a short-lived signed URL; the file itself is never public.
//  2. FILM_EMBED_URL — a private/unlisted player link (Vimeo, Bunny Stream...)
//     that is only revealed to verified buyers.

const SIGNED_URL_SECONDS = 6 * 60 * 60;
let s3 = null;

function s3Client() {
  if (!s3) {
    const endpoint = env('FILM_S3_ENDPOINT');
    s3 = new S3Client({
      region: env('FILM_S3_REGION', endpoint ? 'auto' : 'us-east-1'),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(env('FILM_S3_ACCESS_KEY_ID')
        ? {
            credentials: {
              accessKeyId: env('FILM_S3_ACCESS_KEY_ID'),
              secretAccessKey: env('FILM_S3_SECRET_ACCESS_KEY'),
            },
          }
        : {}),
    });
  }
  return s3;
}

export async function filmSource() {
  const bucket = env('FILM_S3_BUCKET');
  const key = env('FILM_S3_KEY');
  if (bucket && key) {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: 'video/mp4' });
    const src = await getSignedUrl(s3Client(), command, { expiresIn: SIGNED_URL_SECONDS });
    return { kind: 'video', src, expiresIn: SIGNED_URL_SECONDS };
  }
  const embed = env('FILM_EMBED_URL');
  if (embed) return { kind: 'embed', src: embed };
  return { kind: 'none' };
}
