// reviewService.js - the Reviews table (AWS calls only, never req/res)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §5 (Reviews), §6 (a submitted review is final)

const { GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = () => process.env.REVIEWS_TABLE;

// One review per application. attribute_not_exists makes it write-once: a second submit can never overwrite it,
// and there is no update or delete function at all (scores locked after submission).
async function createReview(review) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE(),
      Item: review,
      ConditionExpression: 'attribute_not_exists(applicationId)',
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function getReview(applicationId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { applicationId } }));
  return res.Item || null;
}

// This reviewer's submitted reviews, newest first (reviewerId-index: PK reviewerId, SK submittedAt).
async function listByReviewer(reviewerId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      IndexName: 'reviewerId-index',
      KeyConditionExpression: 'reviewerId = :me',
      ExpressionAttributeValues: { ':me': reviewerId },
      ScanIndexForward: false,
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

module.exports = { createReview, getReview, listByReviewer };
