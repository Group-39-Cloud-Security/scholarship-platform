// applicationStatusService.js — reads and conditional status updates on Applications (AWS calls only, never req/res)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §5, §6 (status flow), §7 (review-service-role)
//
// Every status change is ONE UpdateItem with a ConditionExpression, so two reviewers (or a reviewer and the
// scheduler) can never both win. If the condition fails, DynamoDB throws ConditionalCheckFailedException and
// these functions return false; the controller then decides between 404 and 409.

const { GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = () => process.env.APPLICATIONS_TABLE;
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

async function getApplication(applicationId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { applicationId } }));
  return res.Item || null;
}

// All pages of a Query (DynamoDB returns at most 1 MB per call).
async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// The shared queue: every `submitted` application, oldest first (status-index: PK status, SK submittedAt).
// ProjectionExpression keeps essays, emails and PDFs out of the list.
function listQueue() {
  return queryAll({
    TableName: TABLE(),
    IndexName: 'status-index',
    KeyConditionExpression: '#s = :submitted',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':submitted': 'submitted' },
    ProjectionExpression: 'applicationId, scholarshipId, submittedAt',
    ScanIndexForward: true,
  });
}

// This reviewer's open claims (used for the max-5 rule and for "my reviews").
function listActiveClaims(reviewerId) {
  return queryAll({
    TableName: TABLE(),
    IndexName: 'status-index',
    KeyConditionExpression: '#s = :underReview',
    FilterExpression: 'reviewerId = :me',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':underReview': 'under_review', ':me': reviewerId },
    ProjectionExpression: 'applicationId, scholarshipId, claimedAt, submittedAt',
  });
}

// submitted → under_review. Only succeeds if nobody else claimed it first (atomic claim).
async function claim(applicationId, reviewerId, claimedAt) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { applicationId },
      UpdateExpression: 'SET #s = :underReview, reviewerId = :me, claimedAt = :now',
      ConditionExpression: 'attribute_exists(applicationId) AND #s = :submitted',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':underReview': 'under_review', ':submitted': 'submitted', ':me': reviewerId, ':now': claimedAt },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// under_review → submitted. A reviewer may only release their own claim; an admin may release anyone's (byAdmin).
async function release(applicationId, reviewerId, byAdmin) {
  const ownerCheck = byAdmin ? '' : ' AND reviewerId = :me';
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { applicationId },
      UpdateExpression: 'SET #s = :submitted REMOVE reviewerId, claimedAt',
      ConditionExpression: `attribute_exists(applicationId) AND #s = :underReview${ownerCheck}`,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':submitted': 'submitted', ':underReview': 'under_review',
        ...(byAdmin ? {} : { ':me': reviewerId }),
      },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// under_review → reviewed, by the claimer only. flagged = true means "no score, can only be rejected".
async function markReviewed(applicationId, reviewerId, flagged) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { applicationId },
      UpdateExpression: 'SET #s = :reviewed, flagged = :flagged',
      ConditionExpression: 'attribute_exists(applicationId) AND #s = :underReview AND reviewerId = :me',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':reviewed': 'reviewed', ':underReview': 'under_review', ':me': reviewerId, ':flagged': flagged },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// Undo markReviewed if writing the review itself failed, so the application is never `reviewed` without a review.
async function undoReviewed(applicationId, reviewerId) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { applicationId },
      UpdateExpression: 'SET #s = :underReview REMOVE flagged',
      ConditionExpression: '#s = :reviewed AND reviewerId = :me',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':reviewed': 'reviewed', ':underReview': 'under_review', ':me': reviewerId },
    }));
  } catch (err) {
    if (!isConditionFail(err)) throw err;
  }
}

module.exports = { getApplication, listQueue, listActiveClaims, claim, release, markReviewed, undoReviewed };
