import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    // The shadow database is only for writing new migrations on a laptop (`migrate dev`, `migrate diff`).
    // `migrate deploy` on a server never uses it, so it must not be required there.
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: env('SHADOW_DATABASE_URL') } : {}),
  },
});
