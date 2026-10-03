// PM2 process file for a Droplet (docs/RUNBOOK_PROVISIONING.md §6). The same file runs staging and production: what
// differs is the `.env` next to it (APP_ENV, APP_BASE_URL, database, bucket prefix, keys).
//
//   web     the Express app, in cluster mode so `pm2 reload` swaps workers one at a time with no dropped request
//   worker  the BullMQ worker, one process in fork mode. It is stopped gracefully (SIGINT): it finishes the jobs it
//           has, takes no new ones, then exits. `kill_timeout` is how long PM2 waits before it gives up and kills it.
//
// Both load `.env` themselves (dotenv), so nothing secret is written in this file.
const path = require('node:path');

const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'aeo-web',
      script: 'src/web/server.js',
      cwd: root,
      exec_mode: 'cluster',
      instances: 2,
      max_memory_restart: '600M',
      kill_timeout: 10_000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'aeo-worker',
      script: 'src/worker/index.js',
      cwd: root,
      exec_mode: 'fork',
      instances: 1,
      // A headless browser in the crawler is the memory hog. Restart before the Droplet starts to swap.
      max_memory_restart: '1500M',
      // An audit job can run for minutes: give it time to finish before PM2 stops waiting.
      kill_timeout: 120_000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
