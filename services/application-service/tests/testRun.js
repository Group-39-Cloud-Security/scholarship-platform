// testRun.js — what a test run may clean up: ONLY the applications it created itself.
// Owner: Mohamed Khalil.  Used by tests/api-tests.js and tests/concurrency-tests.js.
//
//   const run = createTestRun(['test-student-1']);
//   run.track(applicationId)       after every 201 from POST /api/applications
//   await run.foreignRows()        rows of those students this run did NOT create → the caller SKIPS, deletes nothing
//   await run.cleanup()            deletes each tracked application, its PDF and its lock rows (only while they
//                                  still point at that application), and returns how many were removed

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { oneKey, slotKey } = require('../src/services/applicationService');
const { MAX_ACTIVE_APPLICATIONS } = require('../src/services/eligibility');

const region = process.env.AWS_REGION || 'us-east-1';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region, forcePathStyle: true });
const APPS = process.env.APPLICATIONS_TABLE || 'Applications';
const BUCKET = process.env.DOCUMENTS_BUCKET || 'scholarship-documents';

async function listStudentRows(studentId) {
  const { Items = [] } = await doc.send(new QueryCommand({
    TableName: APPS, IndexName: 'studentId-index',
    KeyConditionExpression: 'studentId = :s', ExpressionAttributeValues: { ':s': studentId },
  }));
  return Items;
}

// Deletes a lock row only if it still belongs to this application (never someone else's lock).
async function releaseLock(key, applicationId) {
  try {
    await doc.send(new DeleteCommand({
      TableName: APPS, Key: { applicationId: key },
      ConditionExpression: 'holder = :id', ExpressionAttributeValues: { ':id': applicationId },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err; // missing or held by another application
  }
}

function createTestRun(students) {
  const created = new Set();
  return {
    created,
    track(applicationId) { if (applicationId) created.add(applicationId); },
    forget(applicationId) { created.delete(applicationId); }, // already removed through the API (withdraw)

    async foreignRows() {
      const rows = (await Promise.all(students.map(listStudentRows))).flat();
      return rows.filter((a) => !created.has(a.applicationId));
    },

    async cleanup() {
      let removed = 0;
      for (const applicationId of [...created]) {
        const { Item: a } = await doc.send(new GetCommand({ TableName: APPS, Key: { applicationId }, ConsistentRead: true }));
        if (a) {
          await doc.send(new DeleteCommand({ TableName: APPS, Key: { applicationId } }));
          if (a.pdfKey) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: a.pdfKey }));
          await releaseLock(oneKey(a.studentId, a.scholarshipId), applicationId);
          for (let n = 1; n <= MAX_ACTIVE_APPLICATIONS; n += 1) await releaseLock(slotKey(a.studentId, n), applicationId);
          removed += 1;
        }
        created.delete(applicationId);
      }
      return removed;
    },
  };
}

module.exports = { createTestRun };
