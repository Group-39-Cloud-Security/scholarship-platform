// handler.js - release-expired-claims, run every hour by EventBridge Scheduler (release-expired-claims-hourly)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing, §7 (release-expired-claims-role)
//
// Finds under_review applications claimed more than 48 hours ago and puts them back in the queue.
// The update checks that claimedAt is still the value we read, so a claim that changed in the
// meantime (reviewed, released, claimed again) is never touched.

const { QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('./shared/dynamo');
const { writeAudit } = require('./shared/audit');
const { log } = require('./shared/logger');

const CLAIM_HOURS = 48;

async function findExpired(cutoff) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: process.env.APPLICATIONS_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :underReview',
      FilterExpression: 'claimedAt < :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':underReview': 'under_review', ':cutoff': cutoff },
      ProjectionExpression: 'applicationId, reviewerId, claimedAt',
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function releaseOne(app) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: process.env.APPLICATIONS_TABLE,
      Key: { applicationId: app.applicationId },
      UpdateExpression: 'SET #s = :submitted REMOVE reviewerId, claimedAt',
      ConditionExpression: '#s = :underReview AND claimedAt = :seen',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':submitted': 'submitted', ':underReview': 'under_review', ':seen': app.claimedAt },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false; // reviewed or released meanwhile
    throw err;
  }
  await writeAudit({
    action: 'claim_expired',
    userId: 'system',
    targetId: app.applicationId,
    detail: `claim by ${app.reviewerId} released after ${CLAIM_HOURS}h`,
  });
  return true;
}

// The event from the scheduler is ignored: the cutoff always comes from the real clock.
exports.handler = async () => {
  const cutoff = new Date(Date.now() - CLAIM_HOURS * 3600 * 1000).toISOString();
  const expired = await findExpired(cutoff);

  let released = 0;
  for (const app of expired) {
    if (await releaseOne(app)) released += 1;
  }
  log('info', 'release-expired-claims finished', { action: 'claim_expired', checked: expired.length, released });
  return { checked: expired.length, released };
};
