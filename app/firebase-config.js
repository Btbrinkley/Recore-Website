// Firebase web-app configuration for the customer dashboard.
//
// These values are PUBLIC identifiers, not secrets: every Firebase web app ships
// them to browsers. Access is controlled by Firebase Authentication, the
// Firestore security rules (firestore.rules) and the server-side checks in the
// `account` Cloud Function. Never put service-account keys, the ingest key, the
// Brevo key or the OTA fleet key in this file or anywhere in this repository.
//
// Fill in from: Firebase console > Project settings (sentinel-74f28) > General >
// Your apps > Web app (create one named "ReCore customer app" if none) > SDK setup
// and configuration > Config.
export const firebaseConfig = {
  apiKey: "AIzaSyAJ8NufOweCgjBKrAANej7nIxFxRLR5IhA",
  authDomain: "sentinel-74f28.firebaseapp.com",
  projectId: "sentinel-74f28",
  storageBucket: "sentinel-74f28.firebasestorage.app",
  messagingSenderId: "376533606283",
  appId: "1:376533606283:web:339db16e5a0db2c584998e",
};

export const FUNCTIONS_REGION = "us-central1";

// Pinned Firebase JS SDK version loaded from Google's CDN (no build step).
export const FIREBASE_SDK = "11.10.0";

// Set to true only for local testing against `firebase emulators:start`.
export const USE_EMULATORS = false;
