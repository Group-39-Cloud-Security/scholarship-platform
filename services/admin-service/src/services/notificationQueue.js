// notificationQueue.js — puts a decision email on the notifications queue (SQS SendMessage only)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding, §7 (sqs:SendMessage on notifications only)
//
// The message carries everything notification-sender needs, so the sender never reads other tables:
//   { applicationId, studentEmail, scholarshipTitle, decision, flagReason? }
// Never essays, scores, reviewer ids or tokens.

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const sqs = new SQSClient({}); // no endpoint or keys in code (Lab 7): Floci injects AWS_ENDPOINT_URL

async function queueDecisionEmail(message) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.NOTIFICATIONS_QUEUE_URL,
    MessageBody: JSON.stringify(message),
  }));
}

module.exports = { queueDecisionEmail };
