// test-scholarships.js — PHASE A TEST DATA ONLY (not run by deploy-all.sh).
// Owner: Mohamed Khalil.  Usage (from services/application-service):  node scripts/test-scholarships.js
//
// admin-service (Wael) owns the Scholarships table and seed.sh owns real sample data, but both are still TODO.
// To test applying now, this script:
//   1. creates the Scholarships table ONLY IF it is missing, with exactly the key + index from CLAUDE.md §5
//      (Wael's deploy.sh skips an existing table, so nothing clashes);
//   2. writes 5 test scholarships with fixed ids starting with "test-" (re-running overwrites them).
// Delete these test items before the demo, or let platform/reset.sh wipe everything.

const {
  DynamoDBClient, DescribeTableCommand, CreateTableCommand, waitUntilTableExists,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.SCHOLARSHIPS_TABLE || 'Scholarships';
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const doc = DynamoDBDocumentClient.from(client);

const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
const rubric = [
  { criterionId: 'academic', name: 'Academic record', description: 'Grades and courses', weight: 40 },
  { criterionId: 'essay', name: 'Essay', description: 'Clarity and motivation', weight: 40 },
  { criterionId: 'need', name: 'Financial need', description: 'Need shown in the documents', weight: 20 },
];
const base = { description: 'Test scholarship for Phase A.', awards: 2, acceptedCount: 0, rubric, createdBy: 'test-admin', createdAt: new Date().toISOString() };
const anyone = { allowedDomains: ['example-university.edu'], minGpa: 0, years: [1, 2, 3, 4, 5, 6] };

const SCHOLARSHIPS = [
  { ...base, scholarshipId: 'test-open', title: 'Open Merit Scholarship', status: 'published', deadline: inDays(30), eligibility: anyone },
  { ...base, scholarshipId: 'test-open-2', title: 'Second Open Scholarship', status: 'published', deadline: inDays(20), eligibility: anyone },
  { ...base, scholarshipId: 'test-open-3', title: 'Third Open Scholarship', status: 'published', deadline: inDays(25), eligibility: anyone },
  { ...base, scholarshipId: 'test-open-4', title: 'Fourth Open Scholarship', status: 'published', deadline: inDays(28), eligibility: anyone },
  { ...base, scholarshipId: 'test-strict', title: 'High GPA Final-Year Award', status: 'published', deadline: inDays(30),
    eligibility: { allowedDomains: ['other-university.edu'], minGpa: 3.5, years: [4] } },
  { ...base, scholarshipId: 'test-expired', title: 'Expired Scholarship', status: 'published', deadline: inDays(-1), eligibility: anyone },
  { ...base, scholarshipId: 'test-closed', title: 'Closed Scholarship', status: 'closed', deadline: inDays(30), eligibility: anyone },
  { ...base, scholarshipId: 'test-draft', title: 'Draft Scholarship', status: 'draft', deadline: inDays(30), eligibility: anyone },
];

async function ensureTable() {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }));
    console.log(`table ${TABLE} exists`);
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
    await client.send(new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'scholarshipId', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'deadline', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'scholarshipId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'status-deadline-index',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'deadline', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'ALL' },
      }],
    }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
    console.log(`created table ${TABLE} (test only — tell Wael)`);
  }
}

(async () => {
  await ensureTable();
  for (const s of SCHOLARSHIPS) {
    await doc.send(new PutCommand({ TableName: TABLE, Item: s }));
    console.log(`  ${s.scholarshipId.padEnd(13)} ${s.status.padEnd(9)} ${s.title}`);
  }
  console.log('test scholarships ready');
})().catch((err) => {
  console.error('failed:', err.name, err.message);
  process.exit(1);
});
