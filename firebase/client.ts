// Import the functions you need from the SDKs you need
import { getApp, getApps, initializeApp } from "firebase/app";
// import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCJ_iHMHDX4iQvYJbuwbxKPE4bhbgldDVU",
  authDomain: "mock-interviews-14a58-1de09.firebaseapp.com",
  projectId: "mock-interviews-14a58-1de09",
  storageBucket: "mock-interviews-14a58-1de09.firebasestorage.app",
  messagingSenderId: "538130321014",
  appId: "1:538130321014:web:93f551becf0e44dc46d957",
};

// Initialize Firebase
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
// const analytics = getAnalytics(app);

export const auth = getAuth(app);
export const db = getFirestore(app);
