// decisionService.js — Applications/Scholarships/Reviews calls for decisions (AWS calls only, never req/res)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5, §6 Deciding, §7 (admin-service-role)
//
// Every change is ONE UpdateItem with a ConditionExpression. If the condition fails the function returns false
// and the controller decides what to answer. No transactions: the awards limit is an atomic counter (§6).

const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const APPLICATIONS = process.env.APPLICATIONS_TABLE;
const SCHOLARSHIPS = process.env.SCHOLARSHIPS_TABLE;
const REVIEWS = process.env.REVIEWS_TABLE;
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

async function getApplication(applicationId) {
  const res = await docClient.send(new GetCommand({ TableName: APPLICATIONS, Key: { applicationId } }));
  return res.Item || null;
}

// Only the flag reason, for the rejection email (§6). Never the reviewer, scores or note.
async function getFlagReason(applicationId) {
  const res = await docClient.send(new GetCommand({
    TableName: REVIEWS, Key: { applicationId }, ProjectionExpression: 'flagReason',
  }));
  return res.Item ? res.Item.flagReason : undefined;
}

// Take one award: acceptedCount + 1, only while acceptedCount < awards. Atomic, so two admins accepting at the
// same time can never go over the limit.
async function reserveAward(scholarshipId) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: SCHOLARSHIPS,
      Key: { scholarshipId },
      UpdateExpression: 'SET acceptedCount = acceptedCount + :one',
      ConditionExpression: 'attribute_exists(scholarshipId) AND acceptedCount < awards',
      ExpressionAttributeValues: { ':one': 1 },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// Give the award back when the application's status update failed after reserveAward (the rollback).
// Never below 0. Returns false if there was nothing to give back.
async function releaseAward(scholarshipId) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: SCHOLARSHIPS,
      Key: { scholarshipId },
      UpdateExpression: 'SET acceptedCount = acceptedCount - :one',
      ConditionExpression: 'acceptedCount > :zero',
      ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// reviewed → accepted | rejected. Only from reviewed; accepted also needs the application not to be flagged.
// decidedBy comes from the token. emailStatus starts as pending until the queue takes the message.
async function decide(applicationId, decision, adminId, decidedAt) {
  const flagCheck = decision === 'accepted' ? ' AND (attribute_not_exists(flagged) OR flagged = :false)' : '';
  try {
    await docClient.send(new UpdateCommand({
      TableName: APPLICATIONS,
      Key: { applicationId },
      UpdateExpression: 'SET #s = :decision, decidedBy = :admin, decidedAt = :at, emailStatus = :pending',
      ConditionExpression: `attribute_exists(applicationId) AND #s = :reviewed${flagCheck}`,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':decision': decision, ':admin': adminId, ':at': decidedAt, ':pending': 'pending', ':reviewed': 'reviewed',
        ...(decision === 'accepted' ? { ':false': false } : {}),
      },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// queued (the queue took the message) or failed (it didn't). Visible to the admin; notification-sender sets the rest.
async function setEmailStatus(applicationId, emailStatus) {
  await docClient.send(new UpdateCommand({
    TableName: APPLICATIONS,
    Key: { applicationId },
    UpdateExpression: 'SET emailStatus = :e',
    ConditionExpression: 'attribute_exists(applicationId)',
    ExpressionAttributeValues: { ':e': emailStatus },
  }));
}

module.exports = { getApplication, getFlagReason, reserveAward, releaseAward, decide, setEmailStatus };
