/**
 * Make a process that hit an error nobody caught EXIT, so PM2 (or any supervisor) restarts it and an uptime check sees it.
 *
 * Why this exists: PM2 starts a process through its own wrapper, and the wrapper catches `unhandledRejection` itself,
 * prints it and carries on. A server whose start-up throws (a bad `.env` value) then stays "online" in `pm2 status`
 * with nothing listening, and a restart never happens. Importing this module FIRST in a process's entry file (ES module
 * imports run in order, before the file's own code) registers the handlers before anything can throw.
 *
 * It prints the error (the message and stack, which PM2 printed before too) and exits with code 1. It does not try to
 * finish in-flight work: after an uncaught error the process state cannot be trusted.
 */
function die(kind, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: `${kind}: the process is exiting so it can be restarted`,
      error: error.message,
      stack: error.stack,
    }),
  );
  process.exit(1);
}

process.on('unhandledRejection', (err) => die('Unhandled promise rejection', err));
process.on('uncaughtException', (err) => die('Uncaught exception', err));
