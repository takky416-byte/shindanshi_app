// Firebase（Firestore + 匿名認証）を使った、夫婦間のリアルタイム進捗同期。
// アカウント登録は行わず、両端末が同じ「ペアコード」を入力することで、
// Firestore上の同一ドキュメント（rooms/{ペアコードのサニタイズ後ID}）を
// 共有し合う仕組み。アクセス制御はセキュリティルール側（認証済みユーザー
// であればペアコードを知っている者だけがそのドキュメントに到達できる）
// に委ねている。
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// Firebaseコンソール（プロジェクト設定 > 全般 > マイアプリ）で発行される値。
// apiKey等はFirebaseの仕様上クライアントサイドに公開される前提の値であり、
// これ自体は秘匿情報ではない（アクセス制御はFirestoreセキュリティルール側で行う）。
const firebaseConfig = {
  apiKey: "AIzaSyCslr01NWM2IVArgfrPYdnoch2Z50nGlIY",
  authDomain: "shindanshi-app-b7fba.firebaseapp.com",
  projectId: "shindanshi-app-b7fba",
  storageBucket: "shindanshi-app-b7fba.firebasestorage.app",
  messagingSenderId: "547968987992",
  appId: "1:547968987992:web:bdbb83aba1cf53962c2b2d"
};

var app = null;
var auth = null;
var db = null;
var authReadyPromise = null;
var unsubscribeRoom = null;

function ensureInit() {
  if (app) return;
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  try {
    var p = enableIndexedDbPersistence(db);
    if (p && typeof p.catch === "function") p.catch(function () {});
  } catch (e) {
    // 複数タブを開いている場合などに失敗することがあるが、致命的ではないため無視する
  }
}

function ensureSignedIn() {
  ensureInit();
  if (authReadyPromise) return authReadyPromise;
  authReadyPromise = new Promise(function (resolve, reject) {
    var settled = false;
    var unsub = onAuthStateChanged(auth, function (user) {
      if (user && !settled) {
        settled = true;
        unsub();
        resolve(user);
      }
    });
    signInAnonymously(auth).catch(function (err) {
      if (!settled) {
        settled = true;
        unsub();
        reject(err);
      }
    });
  });
  return authReadyPromise;
}

// ペアコードから安全なFirestoreドキュメントIDを作る（前後空白除去・小文字化・
// 使用可能文字への制限）。日本語もそのまま使えるようにひらがな・カタカナ・
// 漢字は許容する。
export function sanitizeRoomCode(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠ー_-]/g, "")
    .slice(0, 60);
}

export function subscribeRoom(roomId, onData, onError) {
  return ensureSignedIn().then(function () {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    var ref = doc(db, "rooms", roomId);
    unsubscribeRoom = onSnapshot(
      ref,
      function (snap) { onData(snap.exists() ? snap.data() : null); },
      onError
    );
  });
}

export function unsubscribeRoomListener() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
}

export function pushRoomData(roomId, data) {
  return ensureSignedIn().then(function () {
    var ref = doc(db, "rooms", roomId);
    return setDoc(ref, data, { merge: true });
  });
}
