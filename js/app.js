import { QUESTIONS, SUBJECTS } from "./questions.js";

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
  var queue = [];
  var queueIdx = 0;
  var answeredThisQuestion = false;

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function buildQueue() {
    var pool = currentSubjectFilter === "all" ? QUESTIONS : QUESTIONS.filter(function (q) { return q.subject === currentSubjectFilter; });
    queue = shuffle(pool);
    queueIdx = 0;
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
      wife: progress.wife
    };
    return b64EncodeUnicode(JSON.stringify(payload));
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

  // ---------- 描画：ユーザーバー ----------
  function renderUserbar() {
    var bar = document.getElementById("userbar");
    bar.innerHTML = "";
    ["husband", "wife"].forEach(function (id) {
      var btn = document.createElement("button");
      btn.className = "user-btn " + (id === "husband" ? "h" : "w");
      btn.textContent = names[id];
      btn.setAttribute("data-active", activeUser === id ? "true" : "false");
      btn.addEventListener("click", function () {
        activeUser = id;
        lsSet("shindanshi_active_user", activeUser);
        renderUserbar();
      });
      bar.appendChild(btn);
    });
  }

  // ---------- 描画：比較ダッシュボード ----------
  function renderCompare() {
    var sh = stats("husband");
    var sw = stats("wife");
    var grid = document.getElementById("compareGrid");
    grid.innerHTML = "";
    [["husband", sh, names.husband], ["wife", sw, names.wife]].forEach(function (pair) {
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
        '</div>';
      grid.appendChild(card);
    });

    var bars = document.getElementById("subjectBars");
    bars.innerHTML = "";
    SUBJECTS.forEach(function (subj) {
      if (subj.key === "all") return;
      var h = sh.bySubject[subj.key], w = sw.bySubject[subj.key];
      var row = document.createElement("div");
      row.className = "subject-bar-row";
      row.innerHTML =
        '<div class="sname">' + escapeHtml(subj.name) + '</div>' +
        '<div class="subject-bar-track">' +
          '<div class="subject-bar-fill h" style="width:' + (h.pct / 2) + '%"></div>' +
          '<div class="subject-bar-fill w" style="width:' + (w.pct / 2) + '%"></div>' +
        '</div>' +
        '<div class="pct num">' + h.pct + '/' + w.pct + '</div>';
      bars.appendChild(row);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- 描画：科目チップ ----------
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
        renderChips();
        buildQueue();
        renderQuestion();
      });
      wrap.appendChild(chip);
    });
  }

  // ---------- 描画：クイズ ----------
  function renderQuestion() {
    if (queue.length === 0) buildQueue();
    if (queue.length === 0) return;
    if (queueIdx >= queue.length) queueIdx = 0;
    var q = queue[queueIdx];
    answeredThisQuestion = false;

    document.getElementById("qSubjectTag").textContent = q.subjectName;
    var sourceTag = document.getElementById("qSourceTag");
    sourceTag.textContent = q.source === "pastexam" ? "過去問" : "オリジナル";
    document.getElementById("qProgress").textContent = (queueIdx + 1) + " / " + queue.length;
    document.getElementById("qText").textContent = q.text;

    var keys = ["ア", "イ", "ウ", "エ"];
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
    document.getElementById("qExplanation").textContent = q.explanation;
    document.getElementById("qNext").hidden = false;

    recordAnswer(activeUser, q.id, q.subject, correct);
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

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    });
  }

  // ---------- イベント登録 ----------
  function bindEvents() {
    document.getElementById("qNext").addEventListener("click", function () {
      queueIdx++;
      if (queueIdx >= queue.length) buildQueue();
      renderQuestion();
    });

    document.getElementById("settingsToggle").addEventListener("click", function () {
      var panel = document.getElementById("settingsPanel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        document.getElementById("nameH").value = names.husband;
        document.getElementById("nameW").value = names.wife;
      }
    });

    document.getElementById("saveNames").addEventListener("click", function () {
      var h = document.getElementById("nameH").value.trim();
      var w = document.getElementById("nameW").value.trim();
      saveNames(h, w);
      renderUserbar();
      renderCompare();
      document.getElementById("settingsPanel").hidden = true;
    });

    document.getElementById("syncExport").addEventListener("click", function () {
      var code = buildSyncCode();
      document.getElementById("syncCode").value = code;
      showSyncMsg("コードを作成しました。相手の端末に伝えてください。", false);
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
    activeUser = lsGet("shindanshi_active_user", "husband");

    loadNames();
    loadProgress();

    renderUserbar();
    renderCompare();
    renderChips();
    buildQueue();
    renderQuestion();
    bindEvents();
    setupInstallBanner();
    registerServiceWorker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
