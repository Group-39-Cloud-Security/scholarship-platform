// auditQueryService.js — AuditLog reads and the stats counts (AWS calls only, never req/res)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5 (AuditLog, status indexes), §7 (AuditLog: Query only besides PutItem)

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

// One page of one action, newest first (PK action, SK sortKey = "<createdAt>#<logId>"). Always a Query on the
// partition key, never a Scan, and at most `limit` rows, so one call can't read the whole table.
async function queryAudit({ action, since, limit, startKey }) {
  const res = await docClient.send(new QueryCommand({
    TableName: process.env.AUDIT_TABLE,
    KeyConditionExpression: since ? '#a = :a AND sortKey >= :since' : '#a = :a',
    ExpressionAttributeNames: { '#a': 'action' },
    ExpressionAttributeValues: { ':a': action, ...(since ? { ':since': since } : {}) },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: startKey,
  }));
  return { items: res.Items || [], lastKey: res.LastEvaluatedKey };
}

// How many items have this status, counted by DynamoDB on a status index (Select COUNT, every page).
async function countByStatus(table, indexName, status) {
  let total = 0;
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      Select: 'COUNT',
      ExclusiveStartKey,
    }));
    total += res.Count || 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

const SCHOLARSHIP_STATUSES = ['draft', 'published', 'closed'];
const APPLICATION_STATUSES = ['submitted', 'under_review', 'reviewed', 'accepted', 'rejected'];

// { scholarships: { draft, published, closed }, applications: { submitted, ..., rejected } }, all from live queries.
async function getStats() {
  const count = (table, index, statuses) => Promise.all(statuses.map((s) => countByStatus(table, index, s)))
    .then((counts) => Object.fromEntries(statuses.map((s, i) => [s, counts[i]])));
  const [scholarships, applications] = await Promise.all([
    count(process.env.SCHOLARSHIPS_TABLE, 'status-deadline-index', SCHOLARSHIP_STATUSES),
    count(process.env.APPLICATIONS_TABLE, 'status-index', APPLICATION_STATUSES),
  ]);
  return { scholarships, applications };
}

module.exports = { queryAudit, getStats };
