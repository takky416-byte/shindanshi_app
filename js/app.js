import { QUESTIONS, SUBJECTS } from "./questions.js";

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
  var queue = [];
  var queueIdx = 0;
  var answeredThisQuestion = false;
  var dashExpanded = false;
  var cloudRoomId = null;

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

  function buildQueue() {
    var pool = QUESTIONS.filter(function (q) {
      var subjectOk = currentSubjectFilter === "all" || q.subject === currentSubjectFilter;
      var yearOk = currentYearFilter === "all" || q.year === currentYearFilter;
      return subjectOk && yearOk;
    });
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
          wife: progress.wife
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

    var summary = document.getElementById("dashSummary");
    summary.innerHTML =
      '<span><strong>' + escapeHtml(names.husband) + '</strong>：' + sh.total + '問・' + sh.accuracy + '%</span>' +
      '<span><strong>' + escapeHtml(names.wife) + '</strong>：' + sw.total + '問・' + sw.accuracy + '%</span>';

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
          '<div class="subject-bar-fill h" style="width:' + barWidthPct(h) + '%"></div>' +
          '<div class="subject-bar-fill w" style="width:' + barWidthPct(w) + '%"></div>' +
        '</div>' +
        '<div class="pct num">' + h.pct + '/' + w.pct + '</div>';
      bars.appendChild(row);
    });
  }

  // 解答数が1以上あるのにpct(正答率)が低いと帯がほぼ見えなくなるため、
  // 解答済みの科目には最低限の可視幅を確保する。
  function barWidthPct(stat) {
    if (!stat.total) return 0;
    return Math.max(stat.pct / 2, 4);
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
        buildQueue();
        renderQuestion();
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
  }

  function setYearFilter(year) {
    currentYearFilter = year;
    lsSet("shindanshi_year_filter", currentYearFilter);
    renderChips();
    buildQueue();
    renderQuestion();
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

  // ---------- 描画：クイズ ----------
  function renderQuestion() {
    if (queue.length === 0) buildQueue();
    var card = document.getElementById("qEmpty");
    if (queue.length === 0) {
      card.hidden = false;
      document.getElementById("qText").innerHTML = "";
      document.getElementById("qChoices").innerHTML = "";
      document.getElementById("qFeedback").hidden = true;
      document.getElementById("qNext").hidden = true;
      return;
    }
    card.hidden = true;
    if (queueIdx >= queue.length) queueIdx = 0;
    var q = queue[queueIdx];
    answeredThisQuestion = false;

    document.getElementById("qSubjectTag").textContent = q.subjectName;
    var sourceTag = document.getElementById("qSourceTag");
    if (q.source === "pastexam") {
      sourceTag.textContent = q.year ? q.year + "年度 過去問" : "過去問";
    } else {
      sourceTag.textContent = "オリジナル";
    }
    document.getElementById("qProgress").textContent = (queueIdx + 1) + " / " + queue.length;
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

  function showSyncAppliedBanner() {
    var banner = document.getElementById("syncAppliedBanner");
    if (!banner) return;
    document.getElementById("syncAppliedMsg").textContent =
      names.husband + "さんと" + names.wife + "さんの進捗を統合しました";
    banner.hidden = false;
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

    document.getElementById("dashToggle").addEventListener("click", function () {
      dashExpanded = !dashExpanded;
      lsSet("shindanshi_dash_expanded", dashExpanded);
      applyDashState();
    });

    document.getElementById("settingsToggle").addEventListener("click", function () {
      var panel = document.getElementById("settingsPanel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        document.getElementById("nameH").value = names.husband;
        document.getElementById("nameW").value = names.wife;
        document.getElementById("roomCodeInput").value = cloudRoomId || "";
      }
    });

    document.getElementById("saveNames").addEventListener("click", function () {
      var h = document.getElementById("nameH").value.trim();
      var w = document.getElementById("nameW").value.trim();
      saveNames(h, w);
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
    activeUser = lsGet("shindanshi_active_user", "husband");
    dashExpanded = lsGet("shindanshi_dash_expanded", false);
    currentSubjectFilter = lsGet("shindanshi_subject_filter", "all");
    currentYearFilter = lsGet("shindanshi_year_filter", "all");

    loadNames();
    loadProgress();
    var syncApplied = applyIncomingSyncFromUrl();

    renderUserbar();
    renderCompare();
    applyDashState();
    renderChips();
    buildQueue();
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
