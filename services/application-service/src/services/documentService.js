// documentService.js — PDFs in the private S3 bucket scholarship-documents (key applications/<applicationId>.pdf).
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §4 (names), §7 (S3 rights on applications/* only), §8 PDFs
// Service layer: AWS calls only, never sees req/res.

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// No endpoint or keys in code (Lab 7): Floci injects AWS_ENDPOINT_URL, real AWS uses the Lambda's IAM role.
// forcePathStyle: the URL is http://<endpoint>/scholarship-documents/... instead of http://scholarship-documents.<endpoint>/...,
// which a Lambda container on Floci may not be able to resolve. It also works on real AWS.
const s3 = new S3Client({ forcePathStyle: true });
const bucket = () => process.env.DOCUMENTS_BUCKET;

const PRESIGN_SECONDS = 300; // download links work for 5 minutes only (§8)

const pdfKey = (applicationId) => `applications/${applicationId}.pdf`;

async function putPdf(key, bytes) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: bytes,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'AES256', // SSE-S3: encrypted at rest (the bucket default is also set by deploy.sh)
  }));
}

async function deletePdf(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// A temporary signed link to ONE object. The bucket itself stays private (Block Public Access on).
// Never log the returned URL: anyone holding it can download the file until it expires.
async function presignPdf(key) {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: 'inline; filename="application.pdf"',
  }), { expiresIn: PRESIGN_SECONDS });
}

module.exports = { pdfKey, putPdf, deletePdf, presignPdf, PRESIGN_SECONDS };
