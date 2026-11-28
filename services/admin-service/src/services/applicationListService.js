// applicationListService.js — one scholarship's applications with their reviews, for the admin (AWS calls only)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5, §7 (admin-service-role: Applications Query, Reviews GetItem), §8
//
// Reads only. The essay and the PDF key are never read here: the admin decides from the review, and the PDF
// stays behind review-service's reviewer-only download.

const { GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const APPLICATIONS = process.env.APPLICATIONS_TABLE;
const REVIEWS = process.env.REVIEWS_TABLE;
const APP_FIELDS = 'applicationId, studentEmail, #s, submittedAt, gpa, yearOfStudy, reviewerId, claimedAt, flagged, '
  + 'decidedAt, decidedBy, emailStatus';
const REVIEWED = ['reviewed', 'accepted', 'rejected']; // the statuses that have a Reviews item

// Every application of this scholarship (scholarshipId-index, every page). application-service's lock rows have
// no scholarshipId attribute, so they are never in this index.
async function listApplications(scholarshipId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: APPLICATIONS,
      IndexName: 'scholarshipId-index',
      KeyConditionExpression: 'scholarshipId = :id',
      ProjectionExpression: APP_FIELDS,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':id': scholarshipId },
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// The review of one application, or null. One GetItem each (the role has no BatchGetItem, on purpose).
async function getReview(applicationId) {
  const res = await docClient.send(new GetCommand({
    TableName: REVIEWS,
    Key: { applicationId },
    ProjectionExpression: 'scores, totalScore, flagged, flagReason, flagNote, submittedAt',
  }));
  return res.Item || null;
}

// Applications + their review, highest total first; flagged and unscored ones after, oldest first among equals.
async function applicationsWithScores(scholarshipId) {
  const apps = await listApplications(scholarshipId);
  const reviews = await Promise.all(apps.map((a) => (REVIEWED.includes(a.status) ? getReview(a.applicationId) : null)));
  const rows = apps.map((a, i) => {
    const r = reviews[i];
    return {
      ...a,
      flagged: a.flagged === true,
      totalScore: r && typeof r.totalScore === 'number' ? r.totalScore : null,
      scores: r && r.scores ? r.scores : null,
      flagReason: r && r.flagReason ? r.flagReason : null,
      flagNote: r && r.flagNote ? r.flagNote : null,
      reviewedAt: r ? r.submittedAt : null,
    };
  });
  return rows.sort((x, y) => (y.totalScore ?? -1) - (x.totalScore ?? -1)
    || String(x.submittedAt).localeCompare(String(y.submittedAt)));
}

module.exports = { applicationsWithScores };
