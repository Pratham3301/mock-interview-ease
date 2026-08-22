import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

interface FirebaseAdminServices {
  auth: Auth;
  db: Firestore;
}

let services: FirebaseAdminServices | undefined;

function initFirebaseAdmin(): FirebaseAdminServices {
  if (services) return services;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
    );
  }

  const apps = getApps();

  if (!apps.length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  services = {
    auth: getAuth(),
    db: getFirestore(),
  };
  return services;
}

function lazyService<T extends object>(getService: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const service = getService();
      const value = Reflect.get(service, property, service);
      return typeof value === "function" ? value.bind(service) : value;
    },
  });
}

export const auth = lazyService(() => initFirebaseAdmin().auth);
export const db = lazyService(() => initFirebaseAdmin().db);
