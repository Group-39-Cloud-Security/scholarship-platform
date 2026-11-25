// applicationStatusService.js - reads and status updates on Applications (AWS calls only, no req/res)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §5, §6 (status flow), §7 (review-service-role)
//
// Every status change is ONE UpdateItem with a ConditionExpression, so two reviewers (or a reviewer and
// the scheduler) can never both win. If the condition fails these functions return false and the
// controller decides between 404 and 409.

const { GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = () => process.env.APPLICATIONS_TABLE;
const QUEUE_LIMIT = 50;
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

async function getApplication(applicationId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { applicationId } }));
  return res.Item || null;
}

// The oldest 50 submitted applications (status-index: PK status, SK submittedAt).
// Only ids and dates are read, never essays or emails.
async function listQueue() {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE(),
    IndexName: 'status-index',
    KeyConditionExpression: '#s = :submitted',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':submitted': 'submitted' },
    ProjectionExpression: 'applicationId, scholarshipId, submittedAt',
    ScanIndexForward: true,
    Limit: QUEUE_LIMIT,
  }));
  return res.Items || [];
}

// This reviewer's open claims, for the max 5 rule and for "my reviews". Reads every page.
async function listActiveClaims(reviewerId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :underReview',
      FilterExpression: 'reviewerId = :me',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':underReview': 'under_review', ':me': reviewerId },
      ProjectionExpression: 'applicationId, scholarshipId, claimedAt, submittedAt',
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// submitted -> under_review, only if nobody claimed it first.
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

// under_review -> submitted. A reviewer can only release their own claim, an admin can release any.
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
        ':submitted': 'submitted',
        ':underReview': 'under_review',
        ...(byAdmin ? {} : { ':me': reviewerId }),
      },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// under_review -> reviewed, by the claimer only. flagged = true means no score and it can only be rejected.
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

// Undo markReviewed if saving the review failed, so an application is never reviewed without a review.
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
