// 診断士ジム：夫婦間のプッシュ通知。
//
// - マイルストーン通知：どちらかの累計解答数が100問区切りを超えたら、相手に知らせる。
// - 相手のペース通知：毎日21時（JST）に、直近7日間の解答数を相手に知らせる
//   （0問の週は通知しない＝何もしていない相手を煽らない）。
//
// 送信先は rooms/{roomId} ドキュメントの pushTokens.{husband|wife}.token
// （クライアント側でFCMトークン取得後にここへ書き込む）。
// アイコン・遷移先URLはクライアント（sw.js）側でデプロイ先パスに応じて
// 組み立てるため、ここでは title/body のみを送る。

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

const MILESTONE_STEP = 100;
const ROLES = ["husband", "wife"];
const OTHER_ROLE = { husband: "wife", wife: "husband" };
const DEFAULT_NAME = { husband: "夫", wife: "妻" };

function answeredCount(progress) {
  return progress && Array.isArray(progress.answered) ? progress.answered.length : 0;
}

function weekCount(progress) {
  if (!progress || !Array.isArray(progress.answered)) return 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return progress.answered.filter((a) => a && a.t >= weekAgo).length;
}

async function sendPush(token, title, body) {
  if (!token) return;
  try {
    await getMessaging().send({
      token,
      data: { title, body }
    });
  } catch (err) {
    // 期限切れ/無効トークンなどはログに残すのみ（利用者への影響はない）。
    console.error("push send failed", err && err.message ? err.message : err);
  }
}

// ---------- マイルストーン通知 ----------
exports.onRoomWriteMilestone = onDocumentWritten("rooms/{roomId}", async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;

  const names = after.names || {};
  const tokens = after.pushTokens || {};

  for (const role of ROLES) {
    const beforeCount = answeredCount(before && before[role]);
    const afterCount = answeredCount(after[role]);
    if (afterCount <= beforeCount) continue;

    const beforeMilestone = Math.floor(beforeCount / MILESTONE_STEP);
    const afterMilestone = Math.floor(afterCount / MILESTONE_STEP);
    if (afterMilestone <= beforeMilestone) continue;

    const otherRole = OTHER_ROLE[role];
    const otherToken = tokens[otherRole] && tokens[otherRole].token;
    if (!otherToken) continue;

    const label = names[role] || DEFAULT_NAME[role];
    const milestone = afterMilestone * MILESTONE_STEP;
    await sendPush(otherToken, "診断士ジム", label + "さんが" + milestone + "問を突破しました！");
  }
});

// ---------- 相手のペース通知（毎日21:00 JST） ----------
exports.dailyPaceNotification = onSchedule(
  { schedule: "0 21 * * *", timeZone: "Asia/Tokyo" },
  async () => {
    const snap = await db.collection("rooms").get();
    const jobs = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const names = data.names || {};
      const tokens = data.pushTokens || {};
      ROLES.forEach((role) => {
        const w = weekCount(data[role]);
        if (w <= 0) return;
        const otherRole = OTHER_ROLE[role];
        const otherToken = tokens[otherRole] && tokens[otherRole].token;
        if (!otherToken) return;
        const label = names[role] || DEFAULT_NAME[role];
        jobs.push(sendPush(otherToken, "診断士ジム", label + "さんは今週" + w + "問解答しています。負けてられない！"));
      });
    });
    await Promise.all(jobs);
  }
);
