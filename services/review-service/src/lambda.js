// lambda.js - Lambda entry point (handler: src/lambda.handler), as in Lab 7.
const serverless = require('serverless-http');
const app = require('./app');
module.exports.handler = serverless(app);
