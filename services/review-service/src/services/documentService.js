// documentService.js - presigned download link for an application's PDF (AWS calls only)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §8 PDFs, §7 (S3 applications/*: GetObject only)
// The bucket is never public: the reviewer gets a link that works for 5 minutes, signed with this Lambda's role.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// forcePathStyle: Floci serves buckets as http://host:4566/<bucket>/<key>, not <bucket>.host.
const s3 = new S3Client({ forcePathStyle: true });
const EXPIRES_IN = 300; // seconds

async function presignPdf(pdfKey) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET, Key: pdfKey }),
    { expiresIn: EXPIRES_IN },
  );
  return { url, expiresIn: EXPIRES_IN };
}

module.exports = { presignPdf };
