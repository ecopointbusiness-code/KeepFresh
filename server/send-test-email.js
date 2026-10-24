// Usage:  npm run test:email -- you@example.com
// Sends one real email through EmailJS and prints exactly what EmailJS answered.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { postEmailJS, mailEnabled } = await import('./src/notify.js');

const to = process.argv[2];
if (!to) { console.error('Give the address to send to:  npm run test:email -- you@example.com'); process.exit(1); }
if (!mailEnabled()) {
  const miss = ['EMAILJS_SERVICE_ID', 'EMAILJS_TEMPLATE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY'].filter((k) => !process.env[k]);
  console.error('Not configured. Missing in server/.env: ' + miss.join(', ')); process.exit(1);
}
console.log(`Sending a test email to ${to} ...`);
const r = await postEmailJS({ to_email: to, to_name: 'there', subject: 'KeepFresh test email', message: 'Success! Your KeepFresh email setup works. Your verification code would appear here, for example 123456.' });
if (r.ok) console.log('OK. EmailJS accepted it. Check the inbox (and Spam) of ' + to);
else { console.error('FAILED. ' + r.error); process.exit(1); }
