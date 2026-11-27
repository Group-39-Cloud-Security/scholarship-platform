// scholarshipReadService.js — read-only access to the Scholarships table (owned by admin-service).
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §5, §7 (this role may only GetItem/Query Scholarships)
// Service layer: AWS calls only, never sees req/res.

const { GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const table = () => process.env.SCHOLARSHIPS_TABLE;

// One scholarship by id, or null. Any status: the controller decides who may see what.
async function getScholarship(scholarshipId) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: table(),
    Key: { scholarshipId },
  }));
  return Item || null;
}

// Every published scholarship, earliest deadline first, using status-deadline-index
// (PK status, SK deadline) instead of scanning the whole table.
async function listPublished() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await docClient.send(new QueryCommand({
      TableName: table(),
      IndexName: 'status-deadline-index',
      KeyConditionExpression: '#s = :published',
      ExpressionAttributeNames: { '#s': 'status' }, // "status" is a DynamoDB reserved word
      ExpressionAttributeValues: { ':published': 'published' },
      ScanIndexForward: true,
      ExclusiveStartKey,
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey; // DynamoDB returns at most 1 MB per page
  } while (ExclusiveStartKey);
  return items;
}

module.exports = { getScholarship, listPublished };
