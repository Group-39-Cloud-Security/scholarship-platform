// config.js — the one place the API address lives
// Owner: Mohamed Khalil (shared shell)   ·   Rules: CLAUDE.md §2 ("API address on Floci")
//
// Leave the placeholder as it is in git. platform/shared.sh replaces __FLOCI_API__ with
// http://<API_ID>.execute-api.localhost.floci.io:4566 in the copy it uploads to S3, so the
// API id never has to be committed and a fresh Floci gets the right address automatically.
// The reviewer pages read the same constant (reviewer/reviewer-common.js).

const FLOCI_API = '__FLOCI_API__';
