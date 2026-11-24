// server.js — local run only (npm run dev). Lambda uses lambda.js instead.
require('dotenv').config({ quiet: true });
const app = require('./app');
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
