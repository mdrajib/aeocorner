import pino from 'pino';
import request from 'supertest';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';

export const BASE = 'https://aeocorner.com';

/** Environments the app runs in. NODE_ENV=test keeps pino quiet and views uncached. */
export const envs = {
  development: { NODE_ENV: 'test', APP_BASE_URL: BASE },
  // Staging runs NODE_ENV=production too; only APP_ENV tells it apart from the live site.
  staging: {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    APP_BASE_URL: 'https://staging.aeocorner.com',
  },
  production: { NODE_ENV: 'production', APP_ENV: 'production', APP_BASE_URL: BASE },
};

export const silentLogger = pino({ level: 'silent' });

/** supertest agent bound to an app built from the given env overrides. */
export function appFor(env = envs.development, options = {}) {
  const config = loadConfig({ ...env, ...options.env });
  const app = createApp({
    config,
    logger: options.logger ?? silentLogger,
    extraRoutes: options.extraRoutes,
  });
  return request(app);
}

export const text = (res) => res.text.replace(/\s+/g, ' ');

export function titleOf(html) {
  return html.match(/<title>([^<]*)<\/title>/)?.[1];
}

export function metaOf(html, name) {
  return html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
}

export function canonicalOf(html) {
  return html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
}
