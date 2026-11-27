// scholarshipService.js — Scholarships table (AWS calls only, never req/res)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5 (Scholarships), §6 (draft → published → closed), §7 (admin-service-role)
//
// Every change is ONE UpdateItem with a ConditionExpression, so two admins (or two clicks) can never both win.
// If the condition fails these functions return null and the controller decides between 404 and 409.

const { GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.SCHOLARSHIPS_TABLE;
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

// New scholarship. attribute_not_exists: a create can never overwrite an existing item, even with a repeated id.
async function createScholarship(scholarship) {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: scholarship,
    ConditionExpression: 'attribute_not_exists(scholarshipId)',
  }));
}

async function getScholarship(scholarshipId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { scholarshipId } }));
  return res.Item || null;
}

// Replace the admin-editable fields, only while the scholarship is still a draft (§6: locked after publish).
// status, acceptedCount, createdBy and createdAt are not in the update, so they can't change here.
async function updateDraft(scholarshipId, fields) {
  try {
    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { scholarshipId },
      UpdateExpression: 'SET title = :title, description = :description, deadline = :deadline, '
        + 'awards = :awards, rubric = :rubric, eligibility = :eligibility',
      ConditionExpression: 'attribute_exists(scholarshipId) AND #s = :draft',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':title': fields.title,
        ':description': fields.description,
        ':deadline': fields.deadline,
        ':awards': fields.awards,
        ':rubric': fields.rubric,
        ':eligibility': fields.eligibility,
        ':draft': 'draft',
      },
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (err) {
    if (isConditionFail(err)) return null;
    throw err;
  }
}

// draft → published, only if the deadline is still in the future and awards >= 1 at the moment of the write.
// Deadlines are stored as toISOString(), so comparing the strings compares the times.
async function publish(scholarshipId, now) {
  try {
    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { scholarshipId },
      UpdateExpression: 'SET #s = :published',
      ConditionExpression: 'attribute_exists(scholarshipId) AND #s = :draft AND deadline > :now AND awards >= :one',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':published': 'published', ':draft': 'draft', ':now': now, ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (err) {
    if (isConditionFail(err)) return null;
    throw err;
  }
}

// published → closed. Stops new applications only; reviewing and deciding existing ones go on (§6).
async function close(scholarshipId) {
  try {
    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { scholarshipId },
      UpdateExpression: 'SET #s = :closed',
      ConditionExpression: 'attribute_exists(scholarshipId) AND #s = :published',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':closed': 'closed', ':published': 'published' },
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (err) {
    if (isConditionFail(err)) return null;
    throw err;
  }
}

module.exports = { createScholarship, getScholarship, updateDraft, publish, close };
