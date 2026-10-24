import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Load server/.env even when started from another folder (existing environment variables win).
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { seed } = await import('./seed.js');
const { createApp } = await import('./app.js');
const { startScheduler } = await import('./checker.js');
const { mailEnabled } = await import('./notify.js');

if (!mailEnabled()) console.warn('\n  ⚠ Email is NOT configured. Sign-up and alerts need it: set the EMAILJS_* values in server/.env (see README).\n');
const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => console.log(`KeepFresh running on http://localhost:${port}  (admin portal: /admin)`));
// Keep the web service available if Firebase is temporarily over quota or
// unreachable. Existing database contents remain untouched if seeding fails.
seed().catch((e) => console.error('[startup] Database seed deferred:', e.message));
startScheduler();
