# KeepFresh Expo client

This is a native React Native client for Expo Go and Expo development builds. The existing React/Vite website and Capacitor Android shell remain in `../client`; the Express API remains in `../server`.

## Run on Expo Go

1. Install Node.js 22.13 or newer and the Expo Go app on an Android phone.
2. Expo Go needs Metro to load the development JavaScript bundle: from `mobile-expo`, run `npm install` and `npx expo start --lan`. The phone and computer must share a network. This is only for development.
3. The app defaults to the deployed Render API. `npm start` is only needed if you explicitly want your phone to use a local server. For that, copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL` to the computer's LAN IPv4 address (not `localhost`).

## Expo development build

An EAS-built standalone APK bundles the app and runs without Metro or `npm start`; the API remains hosted on Render. Expo Go is only for development previews.

## Backend and data

The mobile app uses the KeepFresh server API and keeps its session token in Expo SecureStore. It does not contain database credentials. The server can use Firebase Cloud Firestore for hosted storage, with SQLite available for local development and PostgreSQL/Supabase as an alternative. Configure Firebase service credentials on the server only, never in this app's public Expo variables.

The app includes sign-in, email verification, fridge inventory, freshness alerts, expiry prediction, recipe suggestions and cooking steps, grocery list management, household information, and profile alert settings. The mobile screens use the KeepFresh logo and Android/iOS safe areas so the bottom tabs sit clear of system controls. Recipe suggestions use the server's offline fridge-matched recipe collection when no OpenAI key is configured.

## Android warning push notifications

Remote push notifications need a native APK (they do not work in Expo Go on Android), an Android Firebase app registration, and FCM v1 credentials in EAS. In Firebase Console, add an Android app with package ID `ph.edu.eac.keepfresh`, download its `google-services.json`, and place it in this folder. Add `"googleServicesFile": "./google-services.json"` inside the `android` section of `app.json`. In Expo project credentials, add a Google service-account JSON with the Firebase Cloud Messaging API Admin role for FCM v1. Keep that service-account file private. Set `EXPO_PUSH_ENABLED=true` in the Render server environment and redeploy it. Then build a new APK; sign in and allow notifications when prompted. The phone push toggle is in Profile > Freshness alerts. See [Expo's FCM v1 setup](https://docs.expo.dev/push-notifications/fcm-credentials/) for EAS credential steps.

## Use the existing Expo project and build an Android app

This app is configured for the Expo account project `hestiajass-team/keepfresh`. From this folder, run `npx eas-cli@latest login`, then `npx eas-cli@latest build --platform android --profile preview` to make a standalone APK. The API URL is already configured for the Render service in `eas.json`. For a Google Play upload, use `npx eas-cli@latest build --platform android --profile production` to make an Android App Bundle.
