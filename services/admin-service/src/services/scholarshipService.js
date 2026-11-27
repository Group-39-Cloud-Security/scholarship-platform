// scholarshipService.js — Scholarships table (AWS calls only, never req/res)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5 (Scholarships), §7 (admin-service-role)

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.SCHOLARSHIPS_TABLE;

// New scholarship. attribute_not_exists: a create can never overwrite an existing item, even with a repeated id.
async function createScholarship(scholarship) {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: scholarship,
    ConditionExpression: 'attribute_not_exists(scholarshipId)',
  }));
}

module.exports = { createScholarship };
