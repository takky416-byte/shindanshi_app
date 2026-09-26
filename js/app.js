import { QUESTIONS, SUBJECTS } from "./questions.js";
import { APP_VERSION, APP_UPDATED } from "./version.js";

// cloud-sync.js はFirebase SDK（外部CDN）を静的importしているため、ここで
// 静的importすると、CDNに到達できない環境（電波不良・企業ネットワーク等）で
// アプリ全体が起動しなくなってしまう。クラウド同期が実際に必要になった
// タイミングで動的importし、失敗してもクイズ本体の動作には影響しないようにする。
var cloudSyncModule = null;
var cloudSyncModulePromise = null;
function loadCloudSyncModule() {
  if (cloudSyncModule) return Promise.resolve(cloudSyncModule);
  if (!cloudSyncModulePromise) {
    cloudSyncModulePromise = import("./cloud-sync.js").then(function (mod) {
      cloudSyncModule = mod;
      return mod;
    });
  }
  return cloudSyncModulePromise;
}

// 広告ブロッカーやネットワーク側の制限でFirebaseへの通信が固まった場合、
// dynamic import や Firestore の呼び出しがエラーにも成功にもならずいつまでも
// 待たされることがある。一定時間で強制的にタイムアウトさせ、必ず利用者に
// 何かしらのフィードバック（成功 or エラー）が届くようにする。
function withTimeout(promise, ms, timeoutMessage) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error(timeoutMessage || "timeout"));
    }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

(function () {
  "use strict";

  // ---------- 状態 ----------
  var activeUser = "husband"; // "husband" | "wife"
  var names = { husband: "夫", wife: "妻" };
  var progress = {
    husband: { answered: [], updatedAt: 0 },
    wife: { answered: [], updatedAt: 0 }
  };
  var currentSubjectFilter = "all";
  var currentYearFilter = "all";
  var currentCountFilter = "10"; // "5" | "10" | "20" | "30" | "all"
  var session = null;
  var answeredThisQuestion = false;
  var dashExpanded = false;
  var cloudRoomId = null;
  // 試験日は夫婦で共有する単一の値。複数端末での食い違いは
  // 更新時刻（examDateUpdatedAt）による最終更新優先（last-write-wins）で解決する。
  var examDate = "";
  var examDateUpdatedAt = 0;

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 出題データに実在する年度一覧を新しい順で返す（年度は科目ごとに収録状況が
  // 異なりうるため、決め打ちせずデータから動的に導出する）。
  function getAvailableYears() {
    var seen = {};
    QUESTIONS.forEach(function (q) { if (q.year) seen[q.year] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  // 現在の科目・年度フィルタに該当する問題プール（順序は未シャッフル）。
  function getFilteredPool() {
    return QUESTIONS.filter(function (q) {
      var subjectOk = currentSubjectFilter === "all" || q.subject === currentSubjectFilter;
      var yearOk = currentYearFilter === "all" || q.year === currentYearFilter;
      return subjectOk && yearOk;
    });
  }

  // 問題数チップの候補（5/10/20/30）のうち、現在のプールに対して意味を
  // 持つもの（プールの問題数未満のもの）だけを返す。「全問」は常に別途表示。
  var COUNT_OPTIONS = [5, 10, 20, 30];
  function getAvailableCountOptions(poolSize) {
    return COUNT_OPTIONS.filter(function (n) { return n < poolSize; });
  }

  // ---------- セット演習（出題数を区切ったセッション・周回モード） ----------
  // session の構造:
  //   round        : 今何周目か（1周目は1）
  //   allQuestions : 1周目に出題した「元の全問セット」（周を重ねても不変）
  //   roundHistory : これまでの各周の {round, total, correct} の配列
  //   questions    : 今の周で出題する問題配列（2周目以降は不正解だったものだけ）
  //   index        : 今の周の中での出題位置
  //   answers      : 今の周の解答記録 [{id, subject, correct}]
  function startSession(questions, opts) {
    opts = opts || {};
    session = {
      round: opts.round || 1,
      allQuestions: opts.allQuestions || questions,
      roundHistory: opts.roundHistory || [],
      questions: questions,
      index: 0,
      answers: []
    };
  }

  // 現在の科目・年度・問題数フィルタから、新しい1周目のセッションを開始する。
  function startNewSession() {
    var pool = getFilteredPool();
    if (pool.length === 0) {
      session = null;
      return;
    }
    var n = currentCountFilter === "all" ? pool.length : Math.min(parseInt(currentCountFilter, 10), pool.length);
    startSession(shuffle(pool).slice(0, n));
  }

  // ---------- localStorage 永続化 ----------
  // 本格版は現時点でバックエンド/アカウントを持たないため、進捗はこの端末の
  // localStorage に保存する。夫婦間の同期は「同期コード」の手動共有で行う。
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function loadNames() {
    names.husband = lsGet("shindanshi_name_h", "夫");
    names.wife = lsGet("shindanshi_name_w", "妻");
  }

  function saveNames(h, w) {
    names.husband = h || "夫";
    names.wife = w || "妻";
    lsSet("shindanshi_name_h", names.husband);
    lsSet("shindanshi_name_w", names.wife);
  }

  function loadProgress() {
    progress.husband = lsGet("shindanshi_progress_husband", { answered: [], updatedAt: 0 });
    progress.wife = lsGet("shindanshi_progress_wife", { answered: [], updatedAt: 0 });
  }

  function loadExamDate() {
    examDate = lsGet("shindanshi_exam_date", "");
    examDateUpdatedAt = lsGet("shindanshi_exam_date_updated_at", 0);
  }

  // 片方の端末で試験日を設定・変更したら、もう片方にも同期させる。
  function setExamDate(value) {
    examDate = value || "";
    examDateUpdatedAt = Date.now();
    lsSet("shindanshi_exam_date", examDate);
    lsSet("shindanshi_exam_date_updated_at", examDateUpdatedAt);
  }

  // 同期（クラウド／同期コード）で届いた試験日を取り込む。更新時刻が
  // ローカルより新しい場合のみ採用する（最終更新優先）。
  function applyIncomingExamDate(incomingDate, incomingUpdatedAt) {
    if (typeof incomingUpdatedAt !== "number" || incomingUpdatedAt <= examDateUpdatedAt) return;
    examDate = incomingDate || "";
    examDateUpdatedAt = incomingUpdatedAt;
    lsSet("shindanshi_exam_date", examDate);
    lsSet("shindanshi_exam_date_updated_at", examDateUpdatedAt);
  }

  // ---------- 同期コード（サインイン不要の端末間同期） ----------
  function b64EncodeUnicode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (m, p1) {
      return String.fromCharCode("0x" + p1);
    }));
  }
  function b64DecodeUnicode(str) {
    return decodeURIComponent(atob(str).split("").map(function (c) {
      return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(""));
  }

  function mergeAnswered(a, b) {
    var seen = {};
    var out = [];
    (a || []).concat(b || []).forEach(function (item) {
      var key = item.q + "_" + item.t;
      if (!seen[key]) { seen[key] = true; out.push(item); }
    });
    out.sort(function (x, y) { return x.t - y.t; });
    if (out.length > 1000) out = out.slice(-1000);
    return out;
  }

  function mergeProgress(local, incoming) {
    if (!incoming || typeof incoming !== "object") return local;
    var mergedAnswered = mergeAnswered(local && local.answered, incoming.answered);
    var updatedAt = Math.max((local && local.updatedAt) || 0, incoming.updatedAt || 0);
    return { answered: mergedAnswered, updatedAt: updatedAt };
  }

  function buildSyncCode() {
    var payload = {
      v: 1,
      names: { husband: names.husband, wife: names.wife },
      husband: progress.husband,
      wife: progress.wife,
      examDate: examDate,
      examDateUpdatedAt: examDateUpdatedAt
    };
    return b64EncodeUnicode(JSON.stringify(payload));
  }

  // 同期コードをURLのハッシュに埋め込んだ共有用リンクを作る。相手がこの
  // リンクを開くだけで（コードの手動貼り付けなしに）進捗が取り込まれる。
  function buildSyncUrl() {
    var code = buildSyncCode();
    var url = new URL(location.href);
    url.hash = "";
    return url.toString() + "#sync=" + encodeURIComponent(code);
  }

  function applySyncCode(code) {
    var payload = JSON.parse(b64DecodeUnicode(code.trim()));
    if (!payload || typeof payload !== "object") throw new Error("invalid");
    progress.husband = mergeProgress(progress.husband, payload.husband);
    progress.wife = mergeProgress(progress.wife, payload.wife);
    lsSet("shindanshi_progress_husband", progress.husband);
    lsSet("shindanshi_progress_wife", progress.wife);
    if (payload.names) {
      if (payload.names.husband && names.husband === "夫") names.husband = payload.names.husband;
      if (payload.names.wife && names.wife === "妻") names.wife = payload.names.wife;
      lsSet("shindanshi_name_h", names.husband);
      lsSet("shindanshi_name_w", names.wife);
    }
    applyIncomingExamDate(payload.examDate, payload.examDateUpdatedAt);
  }

  // ページ読み込み時にURLハッシュに #sync=... が付いていれば自動で取り込む。
  // リンクを受け取った側は、タップして開くだけで進捗が統合される。
  function applyIncomingSyncFromUrl() {
    var hash = location.hash || "";
    if (hash.indexOf("#sync=") !== 0) return false;
    var code = hash.slice("#sync=".length);
    try {
      applySyncCode(decodeURIComponent(code));
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    } catch (e) {
      history.replaceState(null, "", location.pathname + location.search);
      return false;
    }
  }

  function recordAnswer(userId, questionId, subject, correct) {
    var p = progress[userId];
    if (!p || typeof p !== "object" || !Array.isArray(p.answered)) {
      p = { answered: [], updatedAt: 0 };
    }
    progress[userId] = p;
    p.answered.push({ q: questionId, s: subject, c: correct, t: Date.now() });
    if (p.answered.length > 1000) p.answered = p.answered.slice(-1000);
    p.updatedAt = Date.now();
    lsSet("shindanshi_progress_" + userId, p);
    renderCompare();
    pushCloudProgress();
  }

  // ---------- クラウド同期（Firebase、ペアコードによるリアルタイム同期） ----------
  function setCloudMsg(text, isErr) {
    var el = document.getElementById("cloudSyncMsg");
    if (!el) return;
    el.textContent = text;
    el.className = "sync-msg" + (isErr ? " err" : "");
  }

  function applyIncomingRoomData(data) {
    if (!data || typeof data !== "object") return;
    progress.husband = mergeProgress(progress.husband, data.husband);
    progress.wife = mergeProgress(progress.wife, data.wife);
    lsSet("shindanshi_progress_husband", progress.husband);
    lsSet("shindanshi_progress_wife", progress.wife);
    if (data.names) {
      if (data.names.husband) names.husband = data.names.husband;
      if (data.names.wife) names.wife = data.names.wife;
      lsSet("shindanshi_name_h", names.husband);
      lsSet("shindanshi_name_w", names.wife);
    }
    applyIncomingExamDate(data.examDate, data.examDateUpdatedAt);
    renderUserbar();
    renderCompare();
  }

  var CLOUD_TIMEOUT_MS = 10000;
  var CLOUD_TIMEOUT_MSG = "エラー：接続がタイムアウトしました。広告ブロッカーや会社・学校のネットワーク、VPN/プライベートDNSの設定などでgoogleapis.com / gstatic.comへの通信がブロックされていないか確認してください。";

  function pushCloudProgress() {
    if (!cloudRoomId) return;
    withTimeout(
      loadCloudSyncModule().then(function (mod) {
        return mod.pushRoomData(cloudRoomId, {
          names: { husband: names.husband, wife: names.wife },
          husband: progress.husband,
          wife: progress.wife,
          examDate: examDate,
          examDateUpdatedAt: examDateUpdatedAt
        });
      }),
      CLOUD_TIMEOUT_MS,
      CLOUD_TIMEOUT_MSG
    ).catch(function (err) {
      setCloudMsg(err && err.message === CLOUD_TIMEOUT_MSG ? CLOUD_TIMEOUT_MSG : "同期に失敗しました。電波状況を確認してもう一度お試しください。", true);
    });
  }

  function connectCloudRoom(rawCode, isResume) {
    // まずボタンを押した時点で即座にフィードバックを出す。裏側の読み込みが
    // 固まっても、利用者が「何も起きていない」と感じることがないようにする。
    if (!isResume) setCloudMsg("接続中…", false);

    withTimeout(loadCloudSyncModule(), CLOUD_TIMEOUT_MS, CLOUD_TIMEOUT_MSG).then(function (mod) {
      var roomId = mod.sanitizeRoomCode(rawCode);
      if (!roomId) {
        setCloudMsg("ペアコードを入力してください。", true);
        return;
      }
      cloudRoomId = roomId;
      lsSet("shindanshi_room_code", roomId);
      withTimeout(
        mod.subscribeRoom(
          roomId,
          function (data) {
            applyIncomingRoomData(data);
            setCloudMsg("同期しています（ペアコード: " + roomId + "）", false);
          },
          function () {
            setCloudMsg("エラー：接続できませんでした。ペアコードや通信環境を確認してください。", true);
          }
        ),
        CLOUD_TIMEOUT_MS,
        CLOUD_TIMEOUT_MSG
      ).then(function () {
        pushCloudProgress();
      }).catch(function (err) {
        setCloudMsg(err && err.message === CLOUD_TIMEOUT_MSG ? CLOUD_TIMEOUT_MSG : "エラー：接続できませんでした。ペアコードや通信環境を確認してください。", true);
      });
    }).catch(function (err) {
      setCloudMsg(
        err && err.message === CLOUD_TIMEOUT_MSG
          ? CLOUD_TIMEOUT_MSG
          : "クラウド同期の読み込みに失敗しました。通信環境を確認してもう一度お試しください（この端末単体でのご利用は引き続き可能です）。",
        true
      );
    });
  }

  function disconnectCloudRoom() {
    if (cloudSyncModule) cloudSyncModule.unsubscribeRoomListener();
    cloudRoomId = null;
    lsSet("shindanshi_room_code", "");
    setCloudMsg("クラウド同期を停止しました（この端末のデータはそのまま残ります）", false);
  }

  // ---------- プッシュ通知の有効化 ----------
  function setPushMsg(text, isErr) {
    var el = document.getElementById("pushMsg");
    if (!el) return;
    el.textContent = text;
    el.className = "sync-msg" + (isErr ? " err" : "");
  }

  function enablePushNotifications() {
    if (!cloudRoomId) {
      setPushMsg("先にクラウド同期でペアコードに接続してください。", true);
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushMsg("この端末・ブラウザは通知に対応していません。", true);
      return;
    }
    setPushMsg("通知を有効化しています…", false);
    Notification.requestPermission().then(function (permission) {
      if (permission !== "granted") {
        setPushMsg("通知が許可されませんでした。ブラウザの設定から許可してください。", true);
        return;
      }
      withTimeout(navigator.serviceWorker.ready, CLOUD_TIMEOUT_MS, CLOUD_TIMEOUT_MSG).then(function (reg) {
        return withTimeout(loadCloudSyncModule(), CLOUD_TIMEOUT_MS, CLOUD_TIMEOUT_MSG).then(function (mod) {
          return withTimeout(mod.requestPushToken(reg), CLOUD_TIMEOUT_MS, CLOUD_TIMEOUT_MSG);
        });
      }).then(function (token) {
        if (!token) throw new Error("no token");
        var tokens = {};
        tokens[activeUser] = { token: token, updatedAt: Date.now() };
        return loadCloudSyncModule().then(function (mod) {
          return mod.pushRoomData(cloudRoomId, { pushTokens: tokens });
        });
      }).then(function () {
        setPushMsg(names[activeUser] + "さんの端末として通知を有効にしました。", false);
      }).catch(function (err) {
        setPushMsg(err && err.message === CLOUD_TIMEOUT_MSG ? CLOUD_TIMEOUT_MSG : "通知の設定に失敗しました。通信環境を確認してもう一度お試しください。", true);
      });
    });
  }

  // ---------- 集計 ----------
  function stats(userId) {
    var answered = progress[userId].answered || [];
    var total = answered.length;
    var correct = answered.filter(function (a) { return a.c; }).length;
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var week = answered.filter(function (a) { return a.t >= weekAgo; }).length;
    var bySubject = {};
    SUBJECTS.forEach(function (s) {
      if (s.key === "all") return;
      var list = answered.filter(function (a) { return a.s === s.key; });
      var c = list.filter(function (a) { return a.c; }).length;
      bySubject[s.key] = { total: list.length, correct: c, pct: list.length ? Math.round((c / list.length) * 100) : 0 };
    });
    return { total: total, correct: correct, accuracy: total ? Math.round((correct / total) * 100) : 0, week: week, bySubject: bySubject };
  }

  // id から設問を引くためのマップ。1646件を毎回 .find() で探すと詳細画面を
  // 開くたびに重くなるため、初回アクセス時に一度だけ構築してキャッシュする。
  var questionById = null;
  function getQuestionById(id) {
    if (!questionById) {
      questionById = {};
      QUESTIONS.forEach(function (q) { questionById[q.id] = q; });
    }
    return questionById[id];
  }

  function dayKey(timestamp) {
    var d = new Date(timestamp);
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  // ---------- 集計：個人ごとの学習記録詳細（科目別・年度別・連続日数・履歴） ----------
  function detailedStats(userId) {
    var answered = (progress[userId] && progress[userId].answered) || [];
    var total = answered.length;
    var correct = answered.filter(function (a) { return a.c; }).length;
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var week = answered.filter(function (a) { return a.t >= weekAgo; }).length;

    var bySubject = {};
    SUBJECTS.forEach(function (s) {
      if (s.key === "all") return;
      bySubject[s.key] = { name: s.name, total: 0, correct: 0 };
    });
    var byYear = {};

    answered.forEach(function (a) {
      if (bySubject[a.s]) {
        bySubject[a.s].total++;
        if (a.c) bySubject[a.s].correct++;
      }
      var q = getQuestionById(a.q);
      if (q && q.year) {
        byYear[q.year] = byYear[q.year] || { total: 0, correct: 0 };
        byYear[q.year].total++;
        if (a.c) byYear[q.year].correct++;
      }
    });

    // 連続学習日数：今日から遡って、1問以上解答している日が何日連続で続いているか。
    var daySet = {};
    answered.forEach(function (a) { daySet[dayKey(a.t)] = true; });
    var streak = 0;
    var cursor = new Date();
    while (daySet[dayKey(cursor.getTime())]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    // 直近7日間の日別解答数（今日を含む、古い日から新しい日の順）。
    var dayBars = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = dayKey(d.getTime());
      var count = answered.filter(function (a) { return dayKey(a.t) === key; }).length;
      dayBars.push({ label: (d.getMonth() + 1) + "/" + d.getDate(), count: count, isToday: i === 0 });
    }

    var recent = answered.slice(-30).reverse().map(function (a) {
      var q = getQuestionById(a.q);
      var text = "";
      if (q) {
        text = q.text || (Array.isArray(q.blocks) && q.blocks.length && q.blocks[0].text) || "";
        text = text.split("\n")[0];
        if (text.length > 42) text = text.slice(0, 42) + "…";
      }
      return {
        t: a.t,
        correct: a.c,
        subjectName: q ? q.subjectName : "",
        year: q ? q.year : null,
        text: text
      };
    });

    return {
      total: total, correct: correct,
      accuracy: total ? Math.round((correct / total) * 100) : 0,
      week: week, streak: streak,
      bySubject: bySubject, byYear: byYear,
      dayBars: dayBars, recent: recent
    };
  }

  function formatHistoryDate(t) {
    var d = new Date(t);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " +
      ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // ---------- 描画：個人詳細画面 ----------
  function renderDetailView(userId) {
    var s = detailedStats(userId);
    var label = names[userId];

    document.getElementById("detailUserName").textContent = label + "さんの学習記録";

    document.getElementById("detailStats").innerHTML =
      '<div class="detail-stat"><div class="v num">' + s.total + '</div><div class="l">解答数（累計）</div></div>' +
      '<div class="detail-stat"><div class="v num">' + s.accuracy + '%</div><div class="l">正答率</div></div>' +
      '<div class="detail-stat"><div class="v num">' + s.week + '</div><div class="l">今週の解答数</div></div>' +
      '<div class="detail-stat"><div class="v num">' + s.streak + '</div><div class="l">連続学習日数</div></div>';

    var maxDay = Math.max.apply(null, s.dayBars.map(function (d) { return d.count; }).concat([1]));
    var dayBarsEl = document.getElementById("detailDayBars");
    dayBarsEl.innerHTML = "";
    s.dayBars.forEach(function (d) {
      var col = document.createElement("div");
      col.className = "detail-daybar-col";
      var barHeight = d.count ? Math.max(Math.round((d.count / maxDay) * 60), 6) : 2;
      col.innerHTML =
        '<div class="detail-daybar-count num">' + (d.count || "") + '</div>' +
        '<div class="detail-daybar" style="height:' + barHeight + 'px"' + (d.isToday ? ' data-today="true"' : '') + '></div>' +
        '<div class="detail-daybar-label">' + d.label + '</div>';
      dayBarsEl.appendChild(col);
    });

    var subjectTable = document.getElementById("detailSubjectTable");
    subjectTable.innerHTML = "";
    SUBJECTS.forEach(function (subj) {
      if (subj.key === "all") return;
      var row = s.bySubject[subj.key];
      var pct = row.total ? Math.round((row.correct / row.total) * 100) : 0;
      var tr = document.createElement("div");
      tr.className = "detail-table-row";
      tr.innerHTML =
        '<div class="detail-table-name">' + escapeHtml(subj.name) + '</div>' +
        '<div class="detail-table-track"><div class="detail-table-fill" style="width:' + (row.total ? Math.max(pct, 4) : 0) + '%"></div></div>' +
        '<div class="detail-table-nums num">' + row.correct + '/' + row.total + '　' + pct + '%</div>';
      subjectTable.appendChild(tr);
    });

    var yearTable = document.getElementById("detailYearTable");
    yearTable.innerHTML = "";
    var years = Object.keys(s.byYear).map(Number).sort(function (a, b) { return b - a; });
    if (years.length === 0) {
      yearTable.innerHTML = '<div class="detail-empty">まだ解答記録がありません。</div>';
    } else {
      years.forEach(function (year) {
        var row = s.byYear[year];
        var pct = row.total ? Math.round((row.correct / row.total) * 100) : 0;
        var tr = document.createElement("div");
        tr.className = "detail-table-row";
        tr.innerHTML =
          '<div class="detail-table-name">' + year + '年度</div>' +
          '<div class="detail-table-track"><div class="detail-table-fill" style="width:' + Math.max(pct, 4) + '%"></div></div>' +
          '<div class="detail-table-nums num">' + row.correct + '/' + row.total + '　' + pct + '%</div>';
        yearTable.appendChild(tr);
      });
    }

    var historyEl = document.getElementById("detailHistory");
    historyEl.innerHTML = "";
    if (s.recent.length === 0) {
      historyEl.innerHTML = '<div class="detail-empty">まだ解答記録がありません。</div>';
    } else {
      s.recent.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "detail-history-row";
        row.innerHTML =
          '<span class="detail-history-verdict ' + (item.correct ? "ok" : "ng") + '">' + (item.correct ? "○" : "×") + '</span>' +
          '<span class="detail-history-main">' +
          '<span class="detail-history-tags">' + escapeHtml(item.subjectName) + (item.year ? '・' + item.year + '年度' : '') + '</span>' +
          '<span class="detail-history-text">' + escapeHtml(item.text) + '</span>' +
          '</span>' +
          '<span class="detail-history-time num">' + formatHistoryDate(item.t) + '</span>';
        historyEl.appendChild(row);
      });
    }

    document.getElementById("detailOverlay").hidden = false;
  }

  // 選んでいる本人のテーマカラーを画面全体に反映する（チップの選択色、
  // 「次の問題へ」ボタン、問題カードの上部ラインなど）。
  function applyUserAccent() {
    var root = document.documentElement.style;
    root.setProperty("--user-accent", "var(--" + activeUser + ")");
    root.setProperty("--user-accent-bg", "var(--" + activeUser + "-bg)");
  }

  // ---------- 描画：ユーザーバー ----------
  function renderUserbar() {
    var bar = document.getElementById("userbar");
    bar.innerHTML = "";
    // 今回の受験の主役は妻なので、妻のボタンを左（先）に置く。
    ["wife", "husband"].forEach(function (id) {
      var btn = document.createElement("button");
      btn.className = "user-btn " + (id === "husband" ? "h" : "w");
      btn.textContent = names[id];
      btn.setAttribute("data-active", activeUser === id ? "true" : "false");
      btn.addEventListener("click", function () {
        activeUser = id;
        lsSet("shindanshi_active_user", activeUser);
        applyUserAccent();
        renderUserbar();
        renderCompare();
      });
      bar.appendChild(btn);
    });
  }

  // ---------- 描画：比較ダッシュボード ----------
  function renderCompare() {
    var sh = stats("husband");
    var sw = stats("wife");

    var summary = document.getElementById("dashSummary");
    summary.innerHTML =
      '<span><strong>' + escapeHtml(names.husband) + '</strong>：' + sh.total + '問・' + sh.accuracy + '%</span>' +
      '<span><strong>' + escapeHtml(names.wife) + '</strong>：' + sw.total + '問・' + sw.accuracy + '%</span>';

    var grid = document.getElementById("compareGrid");
    grid.innerHTML = "";
    // 選んでいる本人の成績を左側（先頭）に表示する。
    var pairs = [["husband", sh, names.husband], ["wife", sw, names.wife]];
    if (activeUser === "wife") pairs.reverse();
    pairs.forEach(function (pair) {
      var id = pair[0], s = pair[1], label = pair[2];
      var leader = (id === "husband" && sh.total >= sw.total && sh.total > 0) || (id === "wife" && sw.total > sh.total);
      var card = document.createElement("div");
      card.className = "compare-card " + (id === "husband" ? "h" : "w");
      card.innerHTML =
        '<div class="name">' + escapeHtml(label) + (leader ? ' <span class="crown">&#9819;</span>' : '') + '</div>' +
        '<div class="big num">' + s.total + '<span style="font-size:13px;font-weight:400;color:var(--ink-soft)">問</span></div>' +
        '<div class="label">解答数（累計）</div>' +
        '<div class="row2">' +
        '<div><div class="n num">' + s.accuracy + '%</div><div class="l">正答率</div></div>' +
        '<div><div class="n num">' + s.week + '</div><div class="l">今週の解答数</div></div>' +
        '</div>' +
        '<button class="detail-open" type="button" data-user="' + id + '">詳しく見る &rarr;</button>';
      grid.appendChild(card);
    });

    grid.querySelectorAll(".detail-open").forEach(function (btn) {
      btn.addEventListener("click", function () {
        renderDetailView(btn.getAttribute("data-user"));
      });
    });

    // 科目別比較：選んでいる本人が常に左側に来る対向型（陣取り型）バー。
    // 左右2人の値の比率でトラック全体（100%）を分け合い、余白は作らない
    // （例：正解数が10対20なら、20の側が2/3を占める）。
    var barPairs = [["husband", sh], ["wife", sw]];
    if (activeUser === "wife") barPairs.reverse();
    var leftClass = barPairs[0][0] === "husband" ? "h" : "w";
    var rightClass = barPairs[1][0] === "husband" ? "h" : "w";
    var leftStat = barPairs[0][1], rightStat = barPairs[1][1];

    function territoryWidths(a, b) {
      var total = a + b;
      if (total <= 0) return [0, 0];
      return [(a / total) * 100, (b / total) * 100];
    }

    var bars = document.getElementById("subjectBars");
    bars.innerHTML = "";
    SUBJECTS.forEach(function (subj) {
      if (subj.key === "all") return;
      var l = leftStat.bySubject[subj.key], r = rightStat.bySubject[subj.key];
      var pctW = territoryWidths(l.pct, r.pct);
      var countW = territoryWidths(l.correct, r.correct);
      var row = document.createElement("div");
      row.className = "subject-compare";
      row.innerHTML =
        '<div class="subject-compare-name">' + escapeHtml(subj.name) + '</div>' +
        '<div class="scm-row">' +
          '<span class="scm-tag">率</span>' +
          '<span class="scm-num left ' + leftClass + '">' + l.pct + '%</span>' +
          '<div class="scm-track">' +
            '<div class="scm-fill ' + leftClass + '" style="width:' + pctW[0] + '%"></div>' +
            '<div class="scm-fill ' + rightClass + '" style="width:' + pctW[1] + '%"></div>' +
          '</div>' +
          '<span class="scm-num right ' + rightClass + '">' + r.pct + '%</span>' +
        '</div>' +
        '<div class="scm-row">' +
          '<span class="scm-tag">数</span>' +
          '<span class="scm-num left ' + leftClass + '">' + l.correct + '問</span>' +
          '<div class="scm-track">' +
            '<div class="scm-fill ' + leftClass + '" style="width:' + countW[0] + '%"></div>' +
            '<div class="scm-fill ' + rightClass + '" style="width:' + countW[1] + '%"></div>' +
          '</div>' +
          '<span class="scm-num right ' + rightClass + '">' + r.correct + '問</span>' +
        '</div>';
      bars.appendChild(row);
    });

    renderReviewCta();
    renderPaceCard();
  }

  // ---------- 弱点復習：全期間の解答履歴から「直近の解答が不正解」の
  // 設問だけを集めた復習セットを作る ----------
  function getWeakQuestionIds(userId) {
    var answered = (progress[userId] && progress[userId].answered) || [];
    var latest = {};
    answered.forEach(function (a) {
      if (!latest[a.q] || a.t > latest[a.q].t) latest[a.q] = a;
    });
    var ids = [];
    Object.keys(latest).forEach(function (qid) {
      if (!latest[qid].c) ids.push(qid);
    });
    return ids;
  }

  function renderReviewCta() {
    var cta = document.getElementById("reviewCta");
    if (!cta) return;
    var ids = getWeakQuestionIds(activeUser);
    if (ids.length === 0) {
      cta.hidden = true;
      return;
    }
    cta.hidden = false;
    document.getElementById("reviewCount").textContent = ids.length;
  }

  function startReviewSession() {
    var ids = getWeakQuestionIds(activeUser);
    var qs = ids.map(getQuestionById).filter(Boolean);
    if (qs.length === 0) return;
    startSession(shuffle(qs));
    renderQuestion(true);
  }

  // ---------- 学習ペースの可視化：試験日までの残り日数と必要ペース ----------
  function getUnattemptedCount(userId) {
    var answered = (progress[userId] && progress[userId].answered) || [];
    var seen = {};
    answered.forEach(function (a) { seen[a.q] = true; });
    return Math.max(QUESTIONS.length - Object.keys(seen).length, 0);
  }

  function renderPaceCard() {
    var card = document.getElementById("paceCard");
    if (!card) return;
    if (!examDate) {
      card.innerHTML = '<div class="pace-empty">設定画面で試験日を登録すると、目標ペースが表示されます。</div>';
      return;
    }
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(examDate + "T00:00:00");
    var diffDays = Math.round((target - today) / (24 * 60 * 60 * 1000));

    if (diffDays < 0) {
      card.innerHTML = '<div class="pace-days">試験日（' + escapeHtml(examDate) + '）は過ぎています。設定から更新してください。</div>';
      return;
    }

    var s = stats(activeUser);
    var remaining = getUnattemptedCount(activeUser);
    var actualPace = Math.round((s.week / 7) * 10) / 10;
    var targetPace = diffDays > 0 ? Math.ceil(remaining / diffDays) : remaining;

    card.innerHTML =
      '<div class="pace-days">' + (diffDays === 0 ? '試験は<strong>今日</strong>です！' : '試験まで<strong>' + diffDays + '</strong>日') + '</div>' +
      '<div class="pace-row"><span class="pace-label">未着手の問題</span><span class="pace-value num">' + remaining + '問</span></div>' +
      '<div class="pace-row"><span class="pace-label">目標ペース（全問1周）</span><span class="pace-value num">' + targetPace + '問/日</span></div>' +
      '<div class="pace-row"><span class="pace-label">' + escapeHtml(names[activeUser]) + 'さんの実ペース（直近7日平均）</span><span class="pace-value num ' + (actualPace >= targetPace ? "ok" : "ng") + '">' + actualPace + '問/日</span></div>';
  }

  // ---------- 表示切替：ダッシュボードの折りたたみ ----------
  function applyDashState() {
    document.getElementById("dashBody").hidden = !dashExpanded;
    document.getElementById("dashSummary").hidden = dashExpanded;
    document.getElementById("dashToggle").setAttribute("aria-expanded", String(dashExpanded));
    document.getElementById("dashToggleLabel").textContent = dashExpanded ? "隠す" : "見る";
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- 描画：科目チップ・年度チップ ----------
  function renderChips() {
    var wrap = document.getElementById("subjectChips");
    wrap.innerHTML = "";
    SUBJECTS.forEach(function (s) {
      var chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = s.name;
      chip.setAttribute("data-active", currentSubjectFilter === s.key ? "true" : "false");
      chip.addEventListener("click", function () {
        currentSubjectFilter = s.key;
        lsSet("shindanshi_subject_filter", currentSubjectFilter);
        renderChips();
        startNewSession();
        renderQuestion(true);
      });
      wrap.appendChild(chip);
    });

    var yearWrap = document.getElementById("yearChips");
    yearWrap.innerHTML = "";
    var allYearsChip = document.createElement("button");
    allYearsChip.className = "chip";
    allYearsChip.textContent = "全年度";
    allYearsChip.setAttribute("data-active", currentYearFilter === "all" ? "true" : "false");
    allYearsChip.addEventListener("click", function () { setYearFilter("all"); });
    yearWrap.appendChild(allYearsChip);
    getAvailableYears().forEach(function (year) {
      var chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = year + "年度";
      chip.setAttribute("data-active", currentYearFilter === year ? "true" : "false");
      chip.addEventListener("click", function () { setYearFilter(year); });
      yearWrap.appendChild(chip);
    });

    renderCountChips();
  }

  function setYearFilter(year) {
    currentYearFilter = year;
    lsSet("shindanshi_year_filter", currentYearFilter);
    renderChips();
    startNewSession();
    renderQuestion(true);
  }

  // ---------- 描画：問題数チップ ----------
  function renderCountChips() {
    var wrap = document.getElementById("countChips");
    wrap.innerHTML = "";
    var poolSize = getFilteredPool().length;
    // プールが小さいと数値チップの選択が「全問」と同じ結果になることがある
    // （例: プール8問に対して「10問」を選んでいる場合）。その場合は
    // 見た目上も「全問」チップの方をアクティブとして扱う。
    var isEffectivelyAll = currentCountFilter === "all" || parseInt(currentCountFilter, 10) >= poolSize;
    getAvailableCountOptions(poolSize).forEach(function (n) {
      var chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = n + "問";
      chip.setAttribute("data-active", (!isEffectivelyAll && currentCountFilter === String(n)) ? "true" : "false");
      chip.addEventListener("click", function () { setCountFilter(String(n)); });
      wrap.appendChild(chip);
    });
    var allChip = document.createElement("button");
    allChip.className = "chip";
    allChip.textContent = "全問（" + poolSize + "問）";
    allChip.setAttribute("data-active", isEffectivelyAll ? "true" : "false");
    allChip.addEventListener("click", function () { setCountFilter("all"); });
    wrap.appendChild(allChip);
  }

  function setCountFilter(count) {
    currentCountFilter = count;
    lsSet("shindanshi_count_filter", currentCountFilter);
    renderCountChips();
    startNewSession();
    renderQuestion(true);
  }

  // 解説文（例:「エが正しい。アは〜のため誤り。イは〜のため誤り。」）を、
  // 選択肢（ア/イ/ウ/エ/オ）ごとに改行して段落として表示するための分割処理。
  // 「アは」のように助詞が続くとは限らない（例:「イの管理図は〜」）ため、
  // 文の先頭1文字が選択肢の文字かどうかだけで判定する。
  var CHOICE_STARTS = { ア: true, イ: true, ウ: true, エ: true, オ: true };
  function splitExplanation(text) {
    if (!text) return [];
    var rawSentences = text.split("。");
    var sentences = [];
    rawSentences.forEach(function (s, i) {
      if (s === "") return;
      sentences.push(i < rawSentences.length - 1 ? s + "。" : s);
    });
    var paragraphs = [];
    var current = "";
    sentences.forEach(function (s) {
      if (CHOICE_STARTS[s.charAt(0)] && current) {
        paragraphs.push(current);
        current = s;
      } else {
        current += s;
      }
    });
    if (current) paragraphs.push(current);
    return paragraphs.length > 0 ? paragraphs : [text];
  }

  function renderExplanation(container, text) {
    container.innerHTML = "";
    splitExplanation(text).forEach(function (p) {
      var line = document.createElement("p");
      line.className = "explanation-line";
      line.textContent = p;
      container.appendChild(line);
    });
  }

  // 設問本文の描画。通常は text（プレーンテキスト、改行はそのまま保持）だが、
  // 表やSQL文を含む設問は blocks（段落／表／コードの配列）を使う。
  function renderQuestionBody(container, q) {
    container.innerHTML = "";
    if (!Array.isArray(q.blocks) || q.blocks.length === 0) {
      var p = document.createElement("p");
      p.className = "q-p";
      p.textContent = q.text;
      container.appendChild(p);
      return;
    }
    q.blocks.forEach(function (block) {
      if (block.type === "table") {
        var wrap = document.createElement("div");
        wrap.className = "q-table-wrap";
        if (block.caption) {
          var cap = document.createElement("div");
          cap.className = "q-table-caption";
          cap.textContent = block.caption;
          wrap.appendChild(cap);
        }
        var table = document.createElement("table");
        table.className = "q-table";
        if (block.headers && block.headers.length) {
          var thead = document.createElement("thead");
          var htr = document.createElement("tr");
          block.headers.forEach(function (h) {
            var th = document.createElement("th");
            th.textContent = h;
            htr.appendChild(th);
          });
          thead.appendChild(htr);
          table.appendChild(thead);
        }
        var tbody = document.createElement("tbody");
        (block.rows || []).forEach(function (row) {
          var tr = document.createElement("tr");
          row.forEach(function (cell) {
            var td = document.createElement("td");
            td.textContent = cell;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        container.appendChild(wrap);
      } else if (block.type === "code") {
        var pre = document.createElement("pre");
        pre.className = "q-code";
        pre.textContent = block.text;
        container.appendChild(pre);
      } else if (block.type === "image") {
        var figure = document.createElement("figure");
        figure.className = "q-figure";
        var img = document.createElement("img");
        img.className = "q-image";
        img.src = block.src;
        img.alt = block.alt || "";
        img.loading = "lazy";
        figure.appendChild(img);
        if (block.caption) {
          var figcap = document.createElement("figcaption");
          figcap.className = "q-figure-caption";
          figcap.textContent = block.caption;
          figure.appendChild(figcap);
        }
        container.appendChild(figure);
      } else {
        var para = document.createElement("p");
        para.className = "q-p";
        para.textContent = block.text;
        container.appendChild(para);
      }
    });
  }

  // ---------- 表示切替：問題カード／結果カード ----------
  function showQuizCard() {
    document.getElementById("quizCard").hidden = false;
    document.getElementById("resultCard").hidden = true;
  }
  function showResultCardEl() {
    document.getElementById("quizCard").hidden = true;
    document.getElementById("resultCard").hidden = false;
  }

  // ---------- 描画：クイズ ----------
  // scrollTop: true の場合、描画後にカードの先頭までスクロールする。
  // 「次の問題へ」ボタンや科目・年度の切り替えなど、明示的に新しい問題へ
  // 移動したときだけ true を渡す（初回表示時にダッシュボード等を
  // 飛ばして問題までスクロールしてしまわないようにするため）。
  function renderQuestion(scrollTop) {
    if (!session) startNewSession();
    showQuizCard();
    var emptyEl = document.getElementById("qEmpty");
    if (!session || session.questions.length === 0) {
      emptyEl.hidden = false;
      document.getElementById("qText").innerHTML = "";
      document.getElementById("qChoices").innerHTML = "";
      document.getElementById("qFeedback").hidden = true;
      document.getElementById("qNext").hidden = true;
      return;
    }
    emptyEl.hidden = true;
    if (scrollTop) {
      var quizCard = document.getElementById("quizCard");
      if (quizCard) quizCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    var q = session.questions[session.index];
    answeredThisQuestion = false;

    document.getElementById("qSubjectTag").textContent = q.subjectName;
    var sourceTag = document.getElementById("qSourceTag");
    if (q.source === "pastexam") {
      sourceTag.textContent = q.year ? q.year + "年度 過去問" : "過去問";
    } else {
      sourceTag.textContent = "オリジナル";
    }
    document.getElementById("qProgress").textContent = (session.index + 1) + " / " + session.questions.length;
    renderQuestionBody(document.getElementById("qText"), q);

    var keys = ["ア", "イ", "ウ", "エ", "オ"];
    var choicesWrap = document.getElementById("qChoices");
    choicesWrap.innerHTML = "";
    q.choices.forEach(function (text, i) {
      var btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.innerHTML = '<span class="key">' + keys[i] + '</span><span>' + escapeHtml(text) + '</span>';
      btn.addEventListener("click", function () { onAnswer(q, i, btn); });
      choicesWrap.appendChild(btn);
    });

    document.getElementById("qFeedback").hidden = true;
    document.getElementById("qNext").hidden = true;
  }

  function onAnswer(q, choiceIdx, btn) {
    if (answeredThisQuestion) return;
    answeredThisQuestion = true;
    var correct = choiceIdx === q.answer;

    Array.prototype.forEach.call(document.getElementById("qChoices").children, function (el, i) {
      el.disabled = true;
      if (i === q.answer) el.classList.add("correct");
      else if (i === choiceIdx && !correct) el.classList.add("wrong");
    });

    var fb = document.getElementById("qFeedback");
    fb.hidden = false;
    var verdict = document.getElementById("qVerdict");
    verdict.textContent = correct ? "正解" : "不正解";
    verdict.className = "verdict " + (correct ? "ok" : "ng");
    renderExplanation(document.getElementById("qExplanation"), q.explanation);
    var nextBtn = document.getElementById("qNext");
    nextBtn.hidden = false;
    nextBtn.textContent = (session.index + 1 >= session.questions.length) ? "結果を見る" : "次の問題へ";

    session.answers.push({ id: q.id, subject: q.subject, correct: correct });
    recordAnswer(activeUser, q.id, q.subject, correct);

    // スマホ等で問題文が長いと、解説がスクロールしないと見えない位置に
    // 描画されることがあるため、解答した瞬間に解説の先頭までスクロールする。
    fb.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- 描画：結果画面 ----------
  function renderResultScreen() {
    var total = session.answers.length;
    var correctCount = session.answers.filter(function (a) { return a.correct; }).length;
    var wrongAnswers = session.answers.filter(function (a) { return !a.correct; });
    var roundHistory = session.roundHistory.concat([{ round: session.round, total: total, correct: correctCount }]);
    var isAllClear = session.round > 1 && wrongAnswers.length === 0;

    showResultCardEl();
    var resultCardEl = document.getElementById("resultCard");
    if (resultCardEl) resultCardEl.scrollIntoView({ behavior: "smooth", block: "start" });

    var allClearEl = document.getElementById("resultAllClear");
    allClearEl.hidden = !isAllClear;

    document.getElementById("resultTitle").textContent =
      session.round > 1 ? session.round + "周目の結果" : "結果";

    var pct = total ? Math.round((correctCount / total) * 100) : 0;
    document.getElementById("resultScore").innerHTML =
      correctCount + ' / ' + total + ' 問正解<span class="pct">（' + pct + '%）</span>';

    var historyEl = document.getElementById("resultHistory");
    historyEl.innerHTML = "";
    if (roundHistory.length > 1) {
      roundHistory.forEach(function (r) {
        var row = document.createElement("div");
        row.className = "result-history-row";
        row.innerHTML =
          '<span class="round-label">' + r.round + '周目</span>' +
          '<span>' + r.correct + ' / ' + r.total + ' 問正解</span>';
        historyEl.appendChild(row);
      });
    }

    var retryBtn = document.getElementById("retryWrongBtn");
    if (wrongAnswers.length > 0) {
      retryBtn.hidden = false;
      retryBtn.textContent = "間違えた問題だけを再挑戦（" + wrongAnswers.length + "問）";
      retryBtn.onclick = function () {
        var wrongQuestions = wrongAnswers
          .map(function (a) { return QUESTIONS.filter(function (qq) { return qq.id === a.id; })[0]; })
          .filter(Boolean);
        startSession(shuffle(wrongQuestions), {
          round: session.round + 1,
          allQuestions: session.allQuestions,
          roundHistory: roundHistory
        });
        renderQuestion(true);
      };
    } else {
      retryBtn.hidden = true;
      retryBtn.onclick = null;
    }

    var restartBtn = document.getElementById("restartAllBtn");
    restartBtn.textContent = "最初からもう一度（全" + session.allQuestions.length + "問）";
    restartBtn.onclick = function () {
      startSession(shuffle(session.allQuestions.slice()));
      renderQuestion(true);
    };
  }

  function showSyncMsg(text, isErr) {
    var el = document.getElementById("syncMsg");
    el.textContent = text;
    el.className = "sync-msg" + (isErr ? " err" : "");
  }

  // ---------- PWA インストール導線 ----------
  var deferredInstallPrompt = null;
  function setupInstallBanner() {
    var banner = document.getElementById("installBanner");
    if (!banner) return;
    if (lsGet("shindanshi_install_dismissed", false)) return;

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      banner.hidden = false;
    });

    document.getElementById("installBtn").addEventListener("click", async function () {
      if (!deferredInstallPrompt) { banner.hidden = true; return; }
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      banner.hidden = true;
    });

    document.getElementById("installDismiss").addEventListener("click", function () {
      banner.hidden = true;
      lsSet("shindanshi_install_dismissed", true);
    });

    window.addEventListener("appinstalled", function () {
      banner.hidden = true;
    });
  }

  function showSyncAppliedBanner() {
    var banner = document.getElementById("syncAppliedBanner");
    if (!banner) return;
    document.getElementById("syncAppliedMsg").textContent =
      names.husband + "さんと" + names.wife + "さんの進捗を統合しました";
    banner.hidden = false;
  }

  // Service Workerの updatefound / statechange イベントに頼る更新検知は、
  // ブラウザがナビゲーション時に自動で行う更新チェックと競合し、こちらの
  // イベントリスナーが間に合わず取りこぼすことがある（実機・自動テストの
  // 両方で確認済み）。より確実な方法として、js/version.js を毎回キャッシュ
  // 無視で直接フェッチし、今読み込んでいるバージョンと食い違っていないかを
  // 比較する方式にした。あわせて reg.update() も呼び、Service Worker側の
  // キャッシュ自体も同じタイミングで新しい内容に更新しておく（そうしないと
  // バナーの「更新する」を押してリロードしても、Service Workerがまだ古い
  // キャッシュのままで実際には更新されない）。
  var swRegistration = null;

  function checkForNewVersion() {
    if (swRegistration) swRegistration.update().catch(function () {});
    var bustedUrl = "./version.js?t=" + Date.now();
    import(bustedUrl).then(function (mod) {
      if (mod.APP_VERSION && mod.APP_VERSION !== APP_VERSION) {
        var banner = document.getElementById("updateBanner");
        if (banner) banner.hidden = false;
      }
    }).catch(function () {});
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").then(function (reg) {
        swRegistration = reg;
        reg.update().catch(function () {});
      }).catch(function () {});
    });

    checkForNewVersion();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkForNewVersion();
    });

    var updateBtn = document.getElementById("updateReloadBtn");
    if (updateBtn) {
      updateBtn.addEventListener("click", function () {
        // SWは install 時に skipWaiting() するため「waiting」状態を経由せず、
        // 新しいSWが実際にactivateしてcontrollerを乗っ取る(controllerchange)まで
        // 待ってからリロードしないと、古いキャッシュのままリロードしてしまう。
        // 万が一controllerchangeが検知できなくても、最大3秒待てば必ずリロードする。
        var reloaded = false;
        function doReload() {
          if (reloaded) return;
          reloaded = true;
          location.reload();
        }
        navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
        if (swRegistration) swRegistration.update().catch(function () {});
        setTimeout(doReload, 3000);
      });
    }
  }

  // ---------- イベント登録 ----------
  function bindEvents() {
    document.getElementById("qNext").addEventListener("click", function () {
      session.index++;
      if (session.index >= session.questions.length) {
        renderResultScreen();
      } else {
        renderQuestion(true);
      }
    });

    document.getElementById("dashToggle").addEventListener("click", function () {
      dashExpanded = !dashExpanded;
      lsSet("shindanshi_dash_expanded", dashExpanded);
      applyDashState();
    });

    document.getElementById("detailClose").addEventListener("click", function () {
      document.getElementById("detailOverlay").hidden = true;
    });

    document.getElementById("reviewStartBtn").addEventListener("click", startReviewSession);

    document.getElementById("settingsToggle").addEventListener("click", function () {
      var panel = document.getElementById("settingsPanel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        document.getElementById("nameH").value = names.husband;
        document.getElementById("nameW").value = names.wife;
        document.getElementById("roomCodeInput").value = cloudRoomId || "";
        document.getElementById("examDateInput").value = examDate;
      }
    });

    document.getElementById("saveNames").addEventListener("click", function () {
      var h = document.getElementById("nameH").value.trim();
      var w = document.getElementById("nameW").value.trim();
      saveNames(h, w);
      setExamDate(document.getElementById("examDateInput").value);
      renderUserbar();
      renderCompare();
      document.getElementById("settingsPanel").hidden = true;
      pushCloudProgress();
    });

    document.getElementById("cloudConnect").addEventListener("click", function () {
      var code = document.getElementById("roomCodeInput").value;
      connectCloudRoom(code, false);
    });

    document.getElementById("cloudDisconnect").addEventListener("click", function () {
      disconnectCloudRoom();
      document.getElementById("roomCodeInput").value = "";
    });

    document.getElementById("pushEnable").addEventListener("click", enablePushNotifications);

    document.getElementById("syncExport").addEventListener("click", function () {
      var code = buildSyncCode();
      document.getElementById("syncCode").value = code;
      showSyncMsg("コードを作成しました。相手の端末に伝えてください。", false);
    });

    document.getElementById("syncShareLink").addEventListener("click", async function () {
      var url = buildSyncUrl();
      if (navigator.share) {
        try {
          await navigator.share({ title: "診断士ジム 進捗の共有", url: url });
          showSyncMsg("共有しました。", false);
          return;
        } catch (e) {
          // ユーザーが共有をキャンセルした場合などはコピーにフォールバック
        }
      }
      document.getElementById("syncCode").value = url;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          showSyncMsg("リンクをコピーしました。LINEなどに貼り付けて送ってください。", false);
        } else {
          showSyncMsg("リンクを作成しました。下のコード欄からコピーして送ってください。", false);
        }
      } catch (e) {
        showSyncMsg("リンクを作成しました。下のコード欄からコピーして送ってください。", false);
      }
    });

    document.getElementById("syncCopy").addEventListener("click", async function () {
      var val = document.getElementById("syncCode").value;
      if (!val) { showSyncMsg("先に「コードを作成」するか、コードを貼り付けてください。", true); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(val);
          showSyncMsg("コピーしました。", false);
        } else {
          var ta = document.getElementById("syncCode");
          ta.focus(); ta.select();
          document.execCommand("copy");
          showSyncMsg("コピーしました。", false);
        }
      } catch (e) {
        showSyncMsg("コピーできませんでした。手動で選択してコピーしてください。", true);
      }
    });

    document.getElementById("syncImport").addEventListener("click", function () {
      var val = document.getElementById("syncCode").value;
      if (!val || !val.trim()) { showSyncMsg("取り込むコードを貼り付けてください。", true); return; }
      try {
        applySyncCode(val);
        renderUserbar();
        renderCompare();
        renderChips();
        showSyncMsg("取り込みました。双方の回答履歴を統合しました。", false);
      } catch (e) {
        showSyncMsg("コードの形式が正しくないようです。コピーし直してもう一度試してください。", true);
      }
    });
  }

  // ---------- 起動 ----------
  function start() {
    var versionEl = document.getElementById("appVersion");
    if (versionEl) versionEl.textContent = APP_VERSION + " ・ " + APP_UPDATED;

    activeUser = lsGet("shindanshi_active_user", "husband");
    applyUserAccent();
    dashExpanded = lsGet("shindanshi_dash_expanded", false);
    currentSubjectFilter = lsGet("shindanshi_subject_filter", "all");
    currentYearFilter = lsGet("shindanshi_year_filter", "all");
    currentCountFilter = lsGet("shindanshi_count_filter", "10");

    loadNames();
    loadProgress();
    loadExamDate();
    var syncApplied = applyIncomingSyncFromUrl();

    renderUserbar();
    renderCompare();
    applyDashState();
    renderChips();
    startNewSession();
    renderQuestion();
    bindEvents();
    setupInstallBanner();
    registerServiceWorker();

    if (syncApplied) showSyncAppliedBanner();

    document.getElementById("syncAppliedDismiss").addEventListener("click", function () {
      document.getElementById("syncAppliedBanner").hidden = true;
    });

    var savedRoomCode = lsGet("shindanshi_room_code", "");
    if (savedRoomCode) connectCloudRoom(savedRoomCode, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
