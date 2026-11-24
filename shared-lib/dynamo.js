// dynamo.js — one DynamoDBDocumentClient for the service
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §2, §9–§10
// No endpoint or keys in code (Lab 7): on Floci, Lambda injects AWS_ENDPOINT_URL; on AWS, the IAM role gives credentials.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// removeUndefinedValues: an optional field left undefined is skipped instead of failing the whole write.
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

module.exports = { docClient };
