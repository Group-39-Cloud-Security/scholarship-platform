// handler.js — notification-sender: one SQS message from `notifications` → one decision email through Brevo
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding, §7 (notification-sender-role), §10 security
//
// Message (from admin-service): { applicationId, studentEmail, scholarshipTitle, decision, flagReason? }
// emailStatus on the application: pending → queued (admin-service) → sending (this handler claims it)
//   → sent, or back to queued to be retried, or failed on the queue's last attempt (then SQS moves it to the DLQ).
// The Brevo key is read from SSM and never logged. The email is plain text only.

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('./shared/dynamo');
const { writeAudit } = require('./shared/audit');
const { log } = require('./shared/logger');

const ssm = new SSMClient({});
const sqs = new SQSClient({});
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const FLAG_REASONS = ['incomplete_documents', 'ineligible', 'plagiarism_suspected', 'other'];
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

// Read once per cold start, then reused while the Lambda stays warm.
let brevoKey;
let maxReceiveCount;

async function getBrevoKey() {
  if (!brevoKey) {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env.BREVO_KEY_PARAM, WithDecryption: true }));
    brevoKey = res.Parameter.Value;
  }
  return brevoKey;
}

// The queue's real redrive setting (maxReceiveCount), so "last attempt" always matches what SQS will do.
// null if it can't be read: then this handler never marks failed by itself, it only throws.
async function getMaxReceiveCount() {
  if (maxReceiveCount === undefined) {
    try {
      const res = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: process.env.NOTIFICATIONS_QUEUE_URL, AttributeNames: ['RedrivePolicy'],
      }));
      const n = Number(JSON.parse(res.Attributes.RedrivePolicy).maxReceiveCount);
      maxReceiveCount = Number.isInteger(n) && n > 0 ? n : null;
    } catch (err) {
      log('error', 'could not read the queue redrive policy', { error: err.name });
      maxReceiveCount = null;
    }
  }
  return maxReceiveCount;
}

// Only the 4-5 known fields, all checked. Anything else in the message is ignored.
function parseMessage(body) {
  let m;
  try { m = JSON.parse(body); } catch { m = null; }
  const ok = m && typeof m === 'object'
    && typeof m.applicationId === 'string' && UUID.test(m.applicationId)
    && typeof m.studentEmail === 'string' && m.studentEmail.length <= 254 && EMAIL.test(m.studentEmail)
    && typeof m.scholarshipTitle === 'string' && m.scholarshipTitle.length > 0 && m.scholarshipTitle.length <= 100
    && ['accepted', 'rejected'].includes(m.decision)
    && (m.flagReason === undefined || FLAG_REASONS.includes(m.flagReason));
  if (!ok) return null;
  return {
    applicationId: m.applicationId, studentEmail: m.studentEmail, scholarshipTitle: m.scholarshipTitle,
    decision: m.decision, flagReason: m.decision === 'rejected' ? m.flagReason : undefined,
  };
}

// One conditional update on emailStatus only (the role allows nothing else). Returns false if the condition failed.
async function moveEmailStatus(applicationId, from, to) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: process.env.APPLICATIONS_TABLE,
      Key: { applicationId },
      UpdateExpression: 'SET emailStatus = :to',
      ConditionExpression: `emailStatus IN (${from.map((_, i) => `:f${i}`).join(', ')})`,
      ExpressionAttributeValues: { ':to': to, ...Object.fromEntries(from.map((s, i) => [`:f${i}`, s])) },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

// Plain text only (textContent), so nothing in the title can become HTML. §6: a flagged rejection gives the reason.
function buildEmail(m) {
  const reasons = {
    incomplete_documents: 'some required documents were missing or incomplete',
    ineligible: 'the application did not meet the eligibility rules',
    plagiarism_suspected: 'the essay could not be accepted as original work',
    other: 'the reviewer found a problem with the application',
  };
  const lines = m.decision === 'accepted'
    ? [`Congratulations! Your application for "${m.scholarshipTitle}" has been accepted.`]
    : [`Thank you for applying for "${m.scholarshipTitle}". Unfortunately your application was not successful.`,
      ...(m.flagReason ? [`Reason: ${reasons[m.flagReason]}.`] : [])];
  return {
    subject: `Your scholarship application: ${m.decision === 'accepted' ? 'accepted' : 'not successful'}`,
    textContent: [...lines, '', 'Scholarship Platform (Group 39)'].join('\n'),
  };
}

async function sendWithBrevo(m) {
  const { subject, textContent } = buildEmail(m);
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': await getBrevoKey(),
      'content-type': 'application/json',
      accept: 'application/json',
      // Sandbox (default on Floci): Brevo checks the request but delivers nothing, so tests never email anyone.
      ...(process.env.BREVO_SANDBOX === 'false' ? {} : { 'X-Sib-Sandbox': 'drop' }),
    },
    body: JSON.stringify({
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'Scholarship Platform' },
      to: [{ email: m.studentEmail }],
      subject,
      textContent,
    }),
    signal: AbortSignal.timeout(10000), // inside the Lambda's 15 s timeout
  });
  if (!res.ok) {
    const err = new Error(`Brevo answered ${res.status}`); // status only: the response body is not logged
    err.name = 'BrevoError';
    throw err;
  }
}

async function handleRecord(record) {
  const m = parseMessage(record.body);
  if (!m) {
    log('error', 'notification message is not valid, not sent', { messageId: record.messageId });
    throw new Error('Invalid notification message'); // retried, then kept in the DLQ for a person to look at
  }

  // Claim the email before sending: only one copy of a duplicated message can move it to "sending",
  // and an email already sent is never sent again.
  if (!(await moveEmailStatus(m.applicationId, ['pending', 'queued'], 'sending'))) {
    log('info', 'email not sent: already sent, being sent, or no such application', { applicationId: m.applicationId });
    return; // nothing to do; SQS deletes this copy
  }

  try {
    await sendWithBrevo(m);
  } catch (err) {
    const attempt = Number(record.attributes && record.attributes.ApproximateReceiveCount);
    const max = await getMaxReceiveCount();
    const last = max !== null && Number.isInteger(attempt) && attempt >= max;
    await moveEmailStatus(m.applicationId, ['sending'], last ? 'failed' : 'queued');
    if (last) {
      await writeAudit({ action: 'email_failed', userId: 'notification-sender', targetId: m.applicationId, detail: `${err.name} after ${attempt} attempts` });
    }
    log('error', 'decision email failed', { applicationId: m.applicationId, attempt, lastAttempt: last, error: err.name });
    throw err; // SQS retries; after the last attempt it moves the message to notifications-dlq
  }

  await moveEmailStatus(m.applicationId, ['sending'], 'sent');
  await writeAudit({ action: 'email_sent', userId: 'notification-sender', targetId: m.applicationId, detail: m.decision });
  log('info', 'decision email sent', { applicationId: m.applicationId, action: 'email_sent' });
}

// BatchSize is 1 (deploy.sh), so a failure only ever retries this one message.
exports.handler = async (event) => {
  for (const record of event.Records || []) await handleRecord(record);
};
