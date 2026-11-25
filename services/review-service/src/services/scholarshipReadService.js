// scholarshipReadService.js — read-only GetItem on Scholarships (the rubric). review-service never writes it.
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §5, §7 (Scholarships: GetItem only)

const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

async function getScholarship(scholarshipId) {
  const res = await docClient.send(new GetCommand({
    TableName: process.env.SCHOLARSHIPS_TABLE,
    Key: { scholarshipId },
    ProjectionExpression: 'scholarshipId, title, #s, deadline, rubric, eligibility',
    ExpressionAttributeNames: { '#s': 'status' },
  }));
  return res.Item || null;
}

// Titles for a list of applications: one GetItem per distinct scholarship, not one per application.
async function getTitles(scholarshipIds) {
  const titles = {};
  await Promise.all([...new Set(scholarshipIds)].map(async (id) => {
    const s = await getScholarship(id);
    titles[id] = s ? s.title : null;
  }));
  return titles;
}

module.exports = { getScholarship, getTitles };
