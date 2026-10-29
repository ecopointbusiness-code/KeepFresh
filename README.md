# KeepFresh

KeepFresh helps households track food, reduce waste, discover meals, and share a grocery list. It includes a React installable PWA, separate admin portal, Node.js API, Firebase Cloud Firestore storage (plus SQLite for local development and PostgreSQL/Supabase as an alternative), Expo mobile app, and ESP32 firmware.

## Features

- Household refrigerator inventory, expiry alerts, history and AI-assisted shelf-life estimates.
- Fridge-matched recipe suggestions that work offline, with optional AI-generated alternatives when an API key is configured. The main recipe ingredient must match a fresh item in that household fridge. Recipes include ingredient amounts, ordered cooking steps, and a step-by-step cooking mode.
- Grocery list, household invites, email and browser push alerts, admin tools, and ESP32 device support.
- Separate customer and admin bundles. Admin API routes require an admin session.
- PWA icons, manifest, service worker, and Capacitor Android configuration.

OpenAI calls run on the server. The API key is never sent to the browser. Without an AI key, expiry predictions fall back to household history and the shelf-life reference table. Recipe suggestions work offline using curated cards matched to fresh fridge inventory. The library includes 16 chicken dishes plus pork, beef, fish and shrimp, egg, tofu, greens, tomato, eggplant, squash, potatoes, dairy, rice, and noodle suggestions. Chicken recipes appear only when chicken or manok is present.

Recipe steps follow a recipe-card format with measured ingredients, cook times, ordered stages, heat levels, and doneness cues. Panlasang Pinoy pages were used as structural inspiration: [Easy Chicken Adobo](https://panlasangpinoy.com/easy-chicken-adobo-recipe-knr-cc/) and [Classic Tinolang Manok](https://panlasangpinoy.com/classic-tinolang-manok-recipe/comment-page-1/). KeepFresh creates original cooking instructions and does not copy their text.

## Run locally

Requirements: Node.js 22.13+, a Firebase service-account key for Firestore, and EmailJS credentials for account verification and email alerts. An OpenAI API key is optional; built-in inventory matching and prediction fallbacks work without it.

```powershell
.\setup-firebase.ps1
npm run setup
# Set ADMIN_PASSWORD and the EmailJS settings in server/.env; OPENAI_API_KEY is optional.
npm run build
npm start
```

Run those commands from the extracted project root in VS Code's PowerShell terminal. The setup script copies the service-account file from your Downloads folder into the ignored `server/` folder and configures Firestore. It does not add that credential to the project ZIP. It keeps an existing `server/.env` and only updates its Firebase settings. The local starter admin password is `Keepfresh@2026`; change it before publishing. EmailJS's newly rotated private key must be added to `server/.env` before email verification can work.

Open `http://localhost:3000` for the customer PWA and `/admin` for the separate admin portal. Local-only default admin: `admin@keepfresh.local` / `Keepfresh@2026`. Set a unique admin email and password before exposing the server. Production mode requires an `ADMIN_PASSWORD` of at least 14 characters and a stable `JWT_SECRET` of at least 32 characters.

`npm start` starts a server on your own computer for local development. It is not needed to use the public site. Once deployed, Render starts the web service and keeps it available at the HTTPS URL; its free instance may sleep when idle and take a short while to wake.

## Configuration

Copy `server/.env.example` to `server/.env` and fill:

- `OPENAI_API_KEY`: optional; enables generated AI recipes and AI expiry estimates. Without it, recipe matching uses built-in curated cards and expiry estimates use household history/reference data. `OPENAI_MODEL` defaults to `gpt-4o-mini`.
- `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY`: required for verification and email alerts.
- Optional `EMAILJS_VERIFICATION_TEMPLATE_ID`, `EMAILJS_RESET_TEMPLATE_ID`, `EMAILJS_WARNING_TEMPLATE_ID`, and `EMAILJS_ANNOUNCEMENT_TEMPLATE_ID` let you use separate EmailJS designs. Blank values fall back to `EMAILJS_TEMPLATE_ID`. For the verification template, use `{{user_name}}`, `{{otp_code}}`, and `{{validity_minutes}}`. For warnings, create a template from [docs/emailjs-warning-template.html](docs/emailjs-warning-template.html), set To Email to `{{to_email}}` and Subject to `{{subject}}`, then set its ID in `EMAILJS_WARNING_TEMPLATE_ID` in `server/.env`.
- `DATABASE_PROVIDER=firebase`, `FIREBASE_PROJECT_ID=keepfresh-c4e5b`, and `FIREBASE_SERVICE_ACCOUNT_FILE=server/firebase-service-account.json`: select the hosted Firestore database. Keep the service-account file private; it is excluded from the source ZIP and must never be placed in the Expo app or public website.
- `DATABASE_URL`: optional Supabase/PostgreSQL connection string. Set `DATABASE_PROVIDER` to empty when using it. For local development, leave both empty and `DB_FILE` (default `./data/keepfresh.db`) selects SQLite.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET`: required in production.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: optional browser push notifications.
- `PUBLIC_URL`: the site's HTTPS origin for email assets.

Recipe suggestions work without an AI key and are matched to fresh household inventory; the main ingredient must exist in the fridge. AI calls, when configured, are rate limited. Each returned recipe is checked against live inventory and stored for that household only. Shelf-life predictions are estimates, not food-safety guarantees. Users may enter the package's expiration date instead.

## Publish

For the existing Render Web Service, use build command `npm run setup && npm run build` and start command `npm start`. Add Firebase credentials, a strong admin password, JWT secret, EmailJS credentials, and public HTTPS URL in Render's Environment settings; do not upload the service-account key to GitHub. Keep HTTPS enabled so the installable PWA and browser push work. After a successful deploy, Render starts the site automatically at its public URL. Its free instance may sleep when idle and take a short while to wake; you do not run `npm start` on your computer to keep the hosted site alive. The Firestore adapter is intended for a small single-instance deployment; a larger multi-instance deployment should move the app to native Firestore queries/transactions before scaling.

## Phone app

The PWA can be installed from the HTTPS website using **Install app** or **Add to Home Screen**. For a native Android package, install Android Studio, then from `client/` run `npm install`, set `VITE_API_URL` to the production HTTPS origin, run `npm run build`, `npx cap sync android`, and build a signed release with Gradle. The native Android project is included at `client/android/`. Browser push is supported on the HTTPS PWA; native APK push needs Firebase/Capacitor push credentials.

## ESP32 indicator unit

Register a device under **Admin > Devices**, copy its API key into `firmware/keepfresh_esp32/keepfresh_esp32.ino`, set Wi-Fi and the HTTPS `SERVER`, install TFT_eSPI and ArduinoJson, then upload. See `docs/wiring-guide.html` for wiring and display setup.

The indicator shows an animated all-clear home screen when no items need attention. When attention items exist, it displays a color-coded warning and pulses the buzzer for one minute, then returns to the home screen. It repeats every 30 minutes until the item is marked used or discarded in the website/app; the device checks for changes about once per minute. No touch input is used.




## Expo mobile app

A native React Native client is in `mobile-expo/`. The standalone APK connects to `https://keepfresh-njtq.onrender.com` and runs without `npm start` or Metro. Build it from that folder with `npx eas-cli@latest build --platform android --profile preview`. Expo Go is only a development preview and still requires `npx expo start`. The app talks to the KeepFresh API; it does not contain Firebase database credentials.

