import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";

// ---------- 保存 ----------
const ITEMS_KEY = "een.items";
const SETTINGS_KEY = "een.settings";
const TALK_KEY = "een.talk";

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast("保存に失敗しました（ストレージ容量を確認してください）");
  }
}

// ストック: { id, ja, en, alts: [英文], createdAt, stats }
let items = load(ITEMS_KEY, []).map((it) => ({
  ...it,
  alts: it.alts || (it.alternatives || []).map((a) => a.english).filter(Boolean),
}));
const settings = Object.assign(
  { apiKey: "", model: "claude-opus-5-5", voice: "", rate: 0.95, accent: "American" },
  load(SETTINGS_KEY, {})
);
const saveItems = () => save(ITEMS_KEY, items);
const saveSettings = () => save(SETTINGS_KEY, settings);

// ---------- 小物 ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const normText = (s) => String(s || "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, "").replace(/\s+/g, " ").trim();

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.style.whiteSpace = "pre-line";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "library") renderLibrary();
  window.scrollTo(0, name === "talk" ? document.body.scrollHeight : 0);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ---------- Claude ----------
// サーバー側フォールバック（安全分類器が拒否した時に別モデルで再実行）に対応するモデル
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// onText を渡すとストリーミングで受け取り、届いた分のテキストを都度渡す
// dropMismatchedThinking: 会話の履歴を送る時に指定。前提（指示文・モデル）が変わって使えなくなった
// 思考ブロックはエラーにせず捨てて続ける
async function callClaude({ system, messages, effort = "low", schema, maxTokens = 4000, onText, dropMismatchedThinking }) {
  if (!settings.apiKey) {
    showView("settings");
    throw new Error("先に設定でAPIキーを入力してください");
  }
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
  };
  if (schema) params.output_config.format = { type: "json_schema", schema };

  const betas = [];
  if (FALLBACK_MODELS.has(settings.model)) {
    betas.push("server-side-fallback-2026-07-01");
    params.fallbacks = "default";
  }
  if (dropMismatchedThinking) {
    betas.push("thinking-binding-controls-2026-08-01");
    params.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
  }
  const body = betas.length ? { ...params, betas } : params;
  const api = betas.length ? client.beta.messages : client.messages;

  let res;
  if (onText) {
    const stream = api.stream(body);
    let soFar = "";
    stream.on("text", (delta) => {
      soFar += delta;
      onText(soFar);
    });
    res = await stream.finalMessage();
  } else {
    res = await api.create(body);
  }

  if (res.stop_reason === "refusal") {
    throw new Error("AIがこの内容への回答を控えました。表現を変えて試してください。");
  }
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { content: res.content, text };
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned);
}

// ストリーミング途中のJSONから、書き終わった文字列フィールドの値を取り出す
function earlyField(partial, key) {
  const m = partial.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

function errMessage(e) {
  const detail = e?.error?.error?.message;
  const suffix = detail ? `\n（詳細: ${detail}）` : "";
  if (e?.status === 401) return `APIキーが正しくないようです。キー全体（sk-ant-api03-…で始まる長い文字列）を貼り直してください${suffix}`;
  if (e?.status === 403) return `このキーでは利用できません。Consoleで権限・ワークスペースを確認してください${suffix}`;
  if (e?.status === 429) return `混み合っているか、利用上限に達しています。少し待ってからもう一度どうぞ${suffix}`;
  if (e?.status === 400 && /credit|billing/i.test(detail || "")) return `クレジット残高が足りません。ConsoleのBillingでクレジットを追加してください${suffix}`;
  return detail || e?.message || String(e);
}

// ---------- 音声（読み上げ） ----------
let voices = [];
const ACCENT_LANG = { American: "en-US", British: "en-GB", Australian: "en-AU" };

function loadVoices() {
  voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  const sel = $("#voice");
  sel.innerHTML = voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join("");
  if (!settings.voice || !voices.some((v) => v.name === settings.voice)) {
    settings.voice = pickDefaultVoice()?.name || "";
  }
  sel.value = settings.voice;
}

function pickDefaultVoice() {
  const lang = ACCENT_LANG[settings.accent] || "en-US";
  const sameLang = voices.filter((v) => v.lang.replace("_", "-") === lang);
  const pool = sameLang.length ? sameLang : voices;
  // 自然な声を優先
  const good = /natural|neural|premium|enhanced|google|samantha|ava|allison|daniel|karen/i;
  return pool.find((v) => good.test(v.name)) || pool[0];
}

if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text, { rate = settings.rate } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      toast("このブラウザは読み上げに対応していません");
      return resolve();
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => x.name === settings.voice);
    if (v) u.voice = v;
    u.lang = v?.lang || ACCENT_LANG[settings.accent];
    u.rate = rate;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

let repeatToken = 0;
async function speakRepeat(text, times = 3) {
  const token = ++repeatToken;
  speechSynthesis.cancel();
  for (let i = 0; i < times; i++) {
    if (token !== repeatToken) return;
    await speak(text);
    await new Promise((r) => setTimeout(r, 1200)); // 真似して言う間
  }
}
function stopSpeaking() {
  repeatToken++;
  speechSynthesis.cancel();
}

// ---------- 音声認識 ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRec = null;

function listen(lang, button) {
  return new Promise((resolve, reject) => {
    if (!Recognition) return reject(new Error("このブラウザは音声入力に対応していません（Chrome / Safari 推奨）"));
    if (activeRec) {
      activeRec.stop();
      return resolve(null);
    }
    stopSpeaking();
    const rec = new Recognition();
    rec.lang = lang;
    rec.maxAlternatives = 3;
    activeRec = rec;
    button?.classList.add("listening");
    let result = null;
    rec.onresult = (e) => {
      const r = e.results[0];
      result = { transcript: r[0].transcript, alternatives: Array.from(r).map((a) => a.transcript) };
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") toast(`音声入力エラー: ${e.error}`);
    };
    rec.onend = () => {
      activeRec = null;
      button?.classList.remove("listening");
      resolve(result);
    };
    rec.start();
  });
}

// ---------- 発音チェック ----------
const COLLOQUIAL = {
  wanna: "want to", gonna: "going to", gotta: "got to", gimme: "give me", lemme: "let me",
  kinda: "kind of", sorta: "sort of", dunno: "do not know", "y'all": "you all", ya: "you",
  "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "it's": "it is",
  "that's": "that is", "what's": "what is", "there's": "there is", "don't": "do not",
  "doesn't": "does not", "didn't": "did not", "can't": "can not", "cannot": "can not",
  "won't": "will not", "isn't": "is not", "aren't": "are not", "i'll": "i will", "you'll": "you will",
  "i've": "i have", "i'd": "i would", "let's": "let us", "gotcha": "got you",
};
const normWords = (s) =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (COLLOQUIAL[w] || w).split(" "));

// 目標文の各単語が、聞き取られた文に順番通り出てきたかを見る
function compareSpeech(target, heard) {
  const t = normWords(target);
  const h = normWords(heard);
  let j = 0;
  const marks = t.map((w) => {
    const k = h.indexOf(w, j);
    if (k === -1) return { w, ok: false };
    j = k + 1;
    return { w, ok: true };
  });
  const score = t.length ? Math.round((marks.filter((m) => m.ok).length / t.length) * 100) : 0;
  return { marks, score };
}

async function pronunciationCheck(item, text, button, outEl) {
  try {
    toast("どうぞ、英文を言ってください");
    const r = await listen(ACCENT_LANG[settings.accent] || "en-US", button);
    if (!r) return;
    const best = r.alternatives
      .map((a) => ({ a, ...compareSpeech(text, a) }))
      .sort((x, y) => y.score - x.score)[0];
    item.stats = item.stats || { plays: 0, checks: 0, best: 0 };
    item.stats.checks++;
    item.stats.best = Math.max(item.stats.best || 0, best.score);
    saveItems();
    const words = best.marks.map((m) => `<span class="${m.ok ? "w-ok" : "w-miss"}">${esc(m.w)}</span>`).join(" ");
    const msg = best.score >= 90 ? "すばらしい！ネイティブに伝わります" : best.score >= 70 ? "いい感じ！赤い単語を意識してもう一度" : "赤い単語がうまく伝わっていません。お手本を聞いてから再挑戦";
    outEl.innerHTML = `<div class="check-result"><b>${best.score}点</b> — ${msg}<br>${words}<br><span class="muted small">聞き取られた文: “${esc(best.a)}”</span></div>`;
  } catch (e) {
    toast(errMessage(e));
  }
}

// ---------- 長押しで調べる ----------
// 英文を単語ごとの span にして、長押しで lookup を開けるようにする
function pressableText(text) {
  const el = document.createElement("span");
  el.className = "lp";
  el.innerHTML = text
    .split(/(\s+)/)
    .map((tok) => (/\S/.test(tok) ? `<span class="w">${esc(tok)}</span>` : tok))
    .join("");
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener("pointerdown", (e) => {
    const w = e.target.closest(".w");
    if (!w) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      w.classList.add("hit");
      navigator.vibrate?.(15);
      openLookup(text, w.textContent.replace(/^[^\w']+|[^\w']+$/g, ""), () => w.classList.remove("hit"));
    }, 450);
  });
  el.addEventListener("pointermove", (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  return el;
}

const LOOKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["phrase", "meaning_ja", "sound_ja", "sentence_ja"],
  properties: {
    phrase: { type: "string" },
    meaning_ja: { type: "string" },
    sound_ja: { type: "string" },
    sentence_ja: { type: "string" },
  },
};

const LOOKUP_SYSTEM = `A Japanese learner long-pressed a word in an English sentence because they didn't catch or understand it. Explain briefly in Japanese.

- phrase: the word, or the whole chunk/idiom/phrasal verb it belongs to in this sentence (e.g. "swing" in "swing by" -> "swing by").
- meaning_ja: what the phrase means here, in one short Japanese sentence.
- sound_ja: one short Japanese sentence on how this part actually sounds at natural speed (linking, reductions, flap T, stress). No katakana spellings. Empty string if nothing notable.
- sentence_ja: a natural Japanese translation of the whole sentence.`;

const lookupCache = new Map();

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}
$("#sheet-backdrop").addEventListener("click", closeSheet);

async function openLookup(sentence, word, onClose) {
  const sheet = $("#sheet");
  sheet.hidden = false;
  $("#sheet-backdrop").hidden = false;
  sheet.innerHTML = `<p class="label">${esc(word)}</p><p class="spinner">調べています…</p>`;
  const done = () => {
    onClose?.();
    closeSheet();
  };
  $("#sheet-backdrop").onclick = done;
  try {
    const key = `${sentence}\u0000${word}`;
    if (!lookupCache.has(key)) {
      const { text } = await callClaude({
        system: LOOKUP_SYSTEM,
        messages: [{ role: "user", content: `Sentence: ${sentence}\nLong-pressed word: ${word}` }],
        effort: "low",
        schema: LOOKUP_SCHEMA,
        maxTokens: 2000,
      });
      lookupCache.set(key, parseJson(text));
    }
    const d = lookupCache.get(key);
    if (sheet.hidden) return;
    const stocked = findItem(sentence);
    sheet.innerHTML = `
      <div class="sheet-head"><b class="phrase-big">${esc(d.phrase)}</b> <button class="btn small" data-act="say-phrase">▶</button></div>
      <p>${esc(d.meaning_ja)}</p>
      ${d.sound_ja ? `<p class="muted">🔊 ${esc(d.sound_ja)}</p>` : ""}
      <p class="muted small">文全体：${esc(d.sentence_ja)}</p>
      <div class="row">
        <button class="btn small" data-act="say-sentence">▶ 文を聞く</button>
        <button class="btn small" data-act="slow">🐢 ゆっくり</button>
        <button class="btn small" data-act="stock" ${stocked ? "disabled" : ""}>${stocked ? "✓ ストック済み" : "📌 この文をストック"}</button>
        <button class="btn small ghost" data-act="close">閉じる</button>
      </div>`;
    sheet.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "say-phrase") speak(d.phrase);
      if (b.dataset.act === "say-sentence") speak(sentence);
      if (b.dataset.act === "slow") speak(sentence, { rate: Math.max(0.5, settings.rate * 0.65) });
      if (b.dataset.act === "close") done();
      if (b.dataset.act === "stock") {
        addItem(sentence, d.sentence_ja);
        b.disabled = true;
        b.textContent = "✓ ストックしました";
      }
    };
  } catch (e) {
    done();
    toast(errMessage(e));
  }
}

// ---------- ストック ----------
function findItem(en) {
  const n = normText(en);
  return items.find((it) => normText(it.en) === n || (it.alts || []).some((a) => normText(a) === n));
}

function addItem(en, ja) {
  const existing = findItem(en);
  if (existing) return existing;
  const item = { id: uid(), ja: ja || "", en, alts: [], createdAt: Date.now(), stats: { plays: 0, checks: 0, best: 0 } };
  items.unshift(item);
  saveItems();
  return item;
}

function addAlternative(baseEn, en, ja) {
  if (findItem(en)) return findItem(en);
  const base = baseEn && findItem(baseEn);
  if (!base) return addItem(en, ja);
  base.alts.push(en);
  saveItems();
  return base;
}

function sentenceRow(item, text, isAlt) {
  const row = document.createElement("div");
  row.className = isAlt ? "alt" : "main-en";
  const line = document.createElement("div");
  line.className = isAlt ? "en-alt" : "en";
  line.append(pressableText(text));
  row.append(line);
  const bar = document.createElement("div");
  bar.className = "player";
  bar.innerHTML = `
    <button class="btn small" data-act="play">▶</button>
    <button class="btn small" data-act="slow">🐢</button>
    <button class="btn small" data-act="repeat">🔁 3回</button>
    <button class="btn small" data-act="stop">■</button>
    <button class="btn small" data-act="check">🎤 発音チェック</button>`;
  const out = document.createElement("div");
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const bump = () => {
      item.stats = item.stats || { plays: 0, checks: 0, best: 0 };
      item.stats.plays++;
      saveItems();
    };
    switch (b.dataset.act) {
      case "play": stopSpeaking(); bump(); return speak(text);
      case "slow": stopSpeaking(); bump(); return speak(text, { rate: Math.max(0.5, settings.rate * 0.65) });
      case "repeat": bump(); return speakRepeat(text, 3);
      case "stop": return stopSpeaking();
      case "check": return pronunciationCheck(item, text, b, out);
    }
  });
  row.append(bar, out);
  return row;
}

function phraseCard(item) {
  const el = document.createElement("div");
  el.className = "card phrase";
  el.innerHTML = item.ja ? `<div class="ja">${esc(item.ja)}</div>` : "";
  el.append(sentenceRow(item, item.en, false));
  (item.alts || []).forEach((a) => el.append(sentenceRow(item, a, true)));
  const foot = document.createElement("div");
  foot.className = "row";
  const s = item.stats || {};
  foot.innerHTML = `
    <span class="stats">再生 ${s.plays || 0}回${s.checks ? ` ・ 発音ベスト ${s.best}点` : ""}</span>
    <span class="spacer"></span>
    <button class="btn small" data-act="talk">💬 これで会話</button>
    <button class="btn small danger" data-act="delete">削除</button>`;
  foot.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "talk") startPractice([item.id]);
    if (b.dataset.act === "delete" && confirm("このストックを削除しますか？")) {
      items = items.filter((x) => x.id !== item.id);
      saveItems();
      el.remove();
      renderLibraryCount();
    }
  });
  el.append(foot);
  return el;
}

function renderLibraryCount() {
  $("#lib-count").textContent = items.length ? `ストック ${items.length} 件（わからない単語は長押し）` : "";
}

function renderLibrary() {
  const q = $("#search").value.trim().toLowerCase();
  const list = $("#library-list");
  list.innerHTML = "";
  renderLibraryCount();
  if (!items.length) {
    list.innerHTML = `<div class="card muted">まだストックがありません。会話で「これ英語でなんて言う？」と聞くと、ここに貯まっていきます。</div>`;
    return;
  }
  items
    .filter((it) => !q || `${it.ja} ${it.en} ${(it.alts || []).join(" ")}`.toLowerCase().includes(q))
    .forEach((it) => list.append(phraseCard(it)));
}
$("#search").addEventListener("input", renderLibrary);

// ---------- 会話 ----------
// history: API に送る履歴（返ってきた content は改変せずに積む）
// log: 画面表示とフィードバック用
// system: 会話を始めた時の指示文。途中で変えると以前の思考ブロックが無効になるため、会話中は固定する
const talk = Object.assign({ history: [], log: [], targets: [], system: "", busy: false }, load(TALK_KEY, {}), { busy: false });
const saveTalk = () => save(TALK_KEY, { history: talk.history, log: talk.log, targets: talk.targets, system: talk.system });

const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "new_expressions"],
  properties: {
    reply: { type: "string" },
    new_expressions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["english", "meaning_ja", "alternative_of"],
        properties: {
          english: { type: "string" },
          meaning_ja: { type: "string" },
          alternative_of: { type: "string" },
        },
      },
    },
  },
};

function talkSystem() {
  const practice = talk.targets.length
    ? `\nThe learner chose these phrases to practice in this conversation. Set up an everyday scene where they fit, use them yourself now and then, and give the learner chances to say them:\n${talk.targets.map((t) => `- "${t.en}"`).join("\n")}\n`
    : "";
  return `You are a friendly native ${settings.accent} English speaker having a casual, everyday conversation with a Japanese learner who already gets by in English and wants to pick up how natives really talk, by ear. Your replies are read aloud by text-to-speech.
${practice}
Conversation style:
- Talk the way natives really talk: contractions, casual phrasing, natural reactions. Keep each reply short — 1-3 spoken sentences — and keep the conversation going.
- Reply in English only, every single time. If the learner writes or speaks Japanese, understand it and carry on in English. Never reply in Japanese.
- Don't correct mistakes or teach during the conversation; the learner gets feedback afterwards.
- The learner's messages come from speech recognition, so ignore missing punctuation and obvious mis-hearings.
- Plain spoken text only: no markdown, lists, emoji, or stage directions.

Expressions the learner asks for (this is how their personal phrase stock grows):
- When they ask how to say something (e.g. "これ英語でなんて言う？", "How do you say ...?", "英語で〜って言いたい"), give the ONE most natural way a native would say it, right in your reply, briefly and without explanation, then keep chatting. Put it in new_expressions with its Japanese meaning and alternative_of "".
- When they ask for another way to say it (e.g. "他の言い方ある？", "Any other way to say it?"), give exactly ONE different natural expression and put it in new_expressions with alternative_of set to the exact English of the expression it's an alternative to.
- When they fall back to Japanese for something they couldn't say in English (a Japanese word or phrase mixed into an English sentence, or a whole line in Japanese), say it back naturally the way a native would ("Oh, you took a little detour?") and keep chatting. Put that natural English in new_expressions with its Japanese meaning and alternative_of "".
- Otherwise new_expressions is empty. Never add expressions or example sentences they didn't ask for.

Output: reply is exactly what you say out loud.`;
}

function addBubble(entry) {
  const el = document.createElement("div");
  el.className = `msg ${entry.role === "learner" ? "me" : "ai"}`;
  if (entry.role === "partner") {
    const body = document.createElement("div");
    body.append(pressableText(entry.text));
    el.append(body);
    const tools = document.createElement("div");
    tools.className = "tools";
    tools.innerHTML = `<button data-r="1">▶</button> <button data-r="0.65">🐢</button>`;
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      stopSpeaking();
      speak(entry.text, { rate: settings.rate * +b.dataset.r });
    });
    el.append(tools);
    (entry.saved || []).forEach((s) => {
      const chip = document.createElement("div");
      chip.className = "saved-chip";
      chip.textContent = `📌 ストック: ${s}`;
      el.append(chip);
    });
  } else {
    el.textContent = entry.text;
  }
  $("#chat").append(el);
  return el;
}

function renderChat() {
  $("#chat").innerHTML = "";
  talk.log.forEach(addBubble);
  $("#chat-hint").hidden = talk.log.length > 0;
  $("#talk-targets").innerHTML = talk.targets.length
    ? `<span class="muted small">練習中のフレーズ：</span><br>` + talk.targets.map((t) => `<span class="tag">${esc(t.en)}</span>`).join(" ")
    : "";
}

function scrollChatEnd() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

async function sendToAI(userText, { hidden = false } = {}) {
  if (talk.busy) return toast("返事を待っています…");
  document.querySelectorAll(".msg-error").forEach((x) => x.remove());
  talk.busy = true;
  $("#feedback").hidden = true;
  $("#chat-hint").hidden = true;
  if (!hidden) {
    const entry = { role: "learner", text: userText };
    talk.log.push(entry);
    addBubble(entry);
  }
  if (!talk.system) talk.system = talkSystem();
  talk.history.push({ role: "user", content: userText });
  const typing = document.createElement("div");
  typing.className = "msg ai typing";
  typing.textContent = "…";
  $("#chat").append(typing);
  scrollChatEnd();

  let shown = null;
  try {
    const { content, text } = await callClaude({
      system: talk.system,
      messages: talk.history,
      effort: "low",
      schema: CHAT_SCHEMA,
      dropMismatchedThinking: true,
      maxTokens: 3000,
      // 返事の文ができた時点で読み上げを始める
      onText: (soFar) => {
        if (shown) return;
        const reply = earlyField(soFar, "reply");
        if (reply) {
          shown = reply;
          typing.textContent = reply;
          typing.classList.remove("typing");
          speak(reply);
        }
      },
    });
    talk.history.push({ role: "assistant", content });
    let data;
    try {
      data = parseJson(text);
    } catch {
      data = { reply: text, new_expressions: [] };
    }
    const saved = [];
    for (const x of data.new_expressions || []) {
      if (!x.english) continue;
      if (x.alternative_of) addAlternative(x.alternative_of, x.english, x.meaning_ja);
      else addItem(x.english, x.meaning_ja);
      saved.push(x.english);
    }
    const entry = { role: "partner", text: data.reply, saved };
    talk.log.push(entry);
    typing.remove();
    addBubble(entry);
    if (shown !== data.reply) speak(data.reply);
    saveTalk();
  } catch (e) {
    typing.remove();
    talk.history.pop();
    if (!hidden) {
      talk.log.pop();
      $("#chat").lastElementChild?.remove();
    }
    showChatError(userText, hidden, e);
  } finally {
    talk.busy = false;
    scrollChatEnd();
  }
}

// 送信できなかった時は、エラー全文と再送信ボタンを会話の中に残す
function showChatError(userText, hidden, e) {
  const el = document.createElement("div");
  el.className = "msg-error";
  el.innerHTML = `<b>送信できませんでした</b><div class="err-detail"></div>
    <div class="row"><button class="btn small" type="button">↻ 再送信</button></div>`;
  el.querySelector(".err-detail").textContent = errMessage(e);
  el.querySelector("button").addEventListener("click", () => {
    el.remove();
    sendToAI(userText, { hidden });
  });
  $("#chat").append(el);
  if (!hidden) $("#chat-input").value = "";
}

$("#send").addEventListener("click", () => {
  // マイクが聞いている途中なら止めて、聞き取った分ごと送る
  if (dict) {
    dict.wanted = false;
    dict.userStopped = true;
    dict.rec.stop();
    return;
  }
  const v = $("#chat-input").value.trim();
  if (!v) return;
  $("#chat-input").value = "";
  sendToAI(v);
});
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#send").click();
  }
});

// ---------- 会話の音声入力 ----------
// もう一度タップするまで聞き続ける。話している途中でも英語⇄日本語を切り替えられ、
// 切り替えのたびに認識をつなぎ直して、それまでに聞き取った分は parts に残す
let micLang = "en";
let dict = null; // { before, parts, current, wanted, switching, rec }

const micLangCode = () => (micLang === "ja" ? "ja-JP" : ACCENT_LANG[settings.accent] || "en-US");

function renderMicLang() {
  const b = $("#mic-lang");
  b.textContent = micLang === "ja" ? "🇯🇵 日本語" : "🇺🇸 英語";
  b.classList.toggle("ja", micLang === "ja");
}

const dictText = () => [dict.before, ...dict.parts, dict.current].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

function runDictation() {
  const rec = new Recognition();
  const sep = micLang === "ja" ? "" : " ";
  rec.lang = micLangCode();
  rec.continuous = true;
  rec.interimResults = true;
  dict.rec = rec;
  const startedAt = Date.now();
  const finals = [];
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finals[i] = r[0].transcript;
      else interim += r[0].transcript;
    }
    dict.current = (finals.filter(Boolean).join(sep) + sep + interim).trim();
    $("#chat-input").value = dictText();
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      dict.wanted = false;
      toast("マイクの使用が許可されていません。ブラウザの設定で許可してください");
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      toast(`音声入力エラー: ${e.error}`);
    }
  };
  rec.onend = () => {
    // 確定しきらなかった分も残す
    if (dict.current) dict.parts.push(dict.current);
    dict.current = "";
    // 言語の切り替え、または途中で勝手に止まった時はつなぎ直す（すぐ止まる時はエラーとみなして終了）
    const restart = dict.wanted && (dict.switching || Date.now() - startedAt > 1000);
    dict.switching = false;
    if (restart) return runDictation();
    finishDictation();
  };
  rec.start();
}

function startDictation() {
  if (!Recognition) return toast("このブラウザは音声入力に対応していません（Chrome / Safari 推奨）");
  stopSpeaking();
  dict = { before: $("#chat-input").value.trim(), parts: [], current: "", wanted: true, switching: false };
  $("#mic").classList.add("listening");
  $("#mic").textContent = "■ 話し終えたらタップ";
  runDictation();
}

function finishDictation() {
  const spoke = dict.parts.length > 0;
  // 自分で止めた時だけ送る（マイク不許可などで止まった時は送らない）
  const text = spoke || dict.userStopped ? dictText() : "";
  dict = null;
  $("#mic").classList.remove("listening");
  $("#mic").textContent = "🎤 話す";
  micLang = "en";
  renderMicLang();
  if (text) {
    $("#chat-input").value = "";
    sendToAI(text);
  }
}

$("#mic").addEventListener("click", () => {
  if (!dict) return startDictation();
  dict.wanted = false;
  dict.userStopped = true;
  dict.rec.stop();
});
$("#mic-lang").addEventListener("click", () => {
  micLang = micLang === "en" ? "ja" : "en";
  renderMicLang();
  if (dict) {
    dict.switching = true;
    dict.rec.stop();
  }
});

function resetTalk(targets = []) {
  Object.assign(talk, { history: [], log: [], targets, system: "", busy: false });
  saveTalk();
  renderChat();
}

async function startPractice(ids) {
  const targets = items.filter((it) => ids.includes(it.id)).map((it) => ({ id: it.id, en: it.en }));
  resetTalk(targets);
  $("#feedback").hidden = true;
  showView("talk");
  await sendToAI("(Start the conversation now: open the scene with your first line.)", { hidden: true });
}

// ---------- フィードバック ----------
const FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "corrections"],
  properties: {
    summary: { type: "string" },
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["you_said", "natural", "meaning_ja", "kind", "explanation"],
        properties: {
          you_said: { type: "string" },
          natural: { type: "string" },
          meaning_ja: { type: "string" },
          kind: { type: "string", enum: ["unnatural", "grammar", "japanese"] },
          explanation: { type: "string" },
        },
      },
    },
  },
};

const FEEDBACK_SYSTEM = `You are an English coach for a Japanese learner who already gets by in English and wants to sound like a native. Review a finished conversation and give feedback in Japanese. Keep it short and practical.

The learner's lines came through speech recognition: ignore punctuation, capitalization and obvious mis-hearings; judge only word choice, grammar and naturalness.

- corrections: each learner line a native would find unnatural, wrong, or textbook-like. Give what they said, how a native would say it in that moment, its Japanese meaning, kind ("grammar" for errors, "unnatural" for correct-but-odd), and a one-sentence Japanese explanation. For lines where the learner fell back to Japanese to say something (not questions like "how do you say this?", which were already answered), use kind "japanese" and give the natural English. Skip lines that are already natural.
- summary: 1-2 Japanese sentences — overall impression and the one thing to focus on next.`;

$("#end-talk").addEventListener("click", async () => {
  stopSpeaking();
  if (!talk.log.some((l) => l.role === "learner")) {
    resetTalk();
    return;
  }
  if (talk.busy) return;
  const btn = $("#end-talk");
  btn.disabled = true;
  const fb = $("#feedback");
  fb.hidden = false;
  fb.innerHTML = `<p class="spinner">会話をふり返っています…</p>`;
  scrollChatEnd();
  const transcript = talk.log.map((l) => `${l.role === "learner" ? "Learner" : "Partner"}: ${l.text}`).join("\n");
  try {
    const { text } = await callClaude({
      system: FEEDBACK_SYSTEM,
      messages: [{ role: "user", content: `Conversation:\n${transcript}` }],
      effort: "medium",
      schema: FEEDBACK_SCHEMA,
      maxTokens: 8000,
    });
    const data = parseJson(text);
    resetTalk();
    renderFeedback(data);
  } catch (e) {
    fb.innerHTML = `<div class="card">フィードバックの作成に失敗しました：${esc(errMessage(e))}</div>`;
  } finally {
    btn.disabled = false;
  }
});

function renderFeedback(data) {
  const fb = $("#feedback");
  fb.hidden = false;
  $("#chat-hint").hidden = true;
  const kindLabel = { grammar: "文法", unnatural: "より自然に", japanese: "日本語→英語" };
  fb.innerHTML = `
    <div class="card">
      <p class="label">ふり返り</p>
      <p>${esc(data.summary)}</p>
      ${data.corrections?.length ? "" : "<p>不自然な表現はありませんでした 🎉</p>"}
    </div>
    <div id="fb-list"></div>`;
  const list = fb.querySelector("#fb-list");
  (data.corrections || []).forEach((c) => {
    const el = document.createElement("div");
    el.className = `fb-item ${c.kind === "japanese" ? "ja" : ""}`;
    el.innerHTML = `
      <span class="tag">${kindLabel[c.kind] || ""}</span>
      <div class="said">${esc(c.you_said)}</div>
      <div class="better"></div>
      <div>${esc(c.explanation)}</div>
      <div class="row">
        <button class="btn small" data-act="play">▶ 聞く</button>
        <button class="btn small" data-act="add" ${findItem(c.natural) ? "disabled" : ""}>${findItem(c.natural) ? "✓ ストック済み" : "📌 ストック"}</button>
      </div>`;
    el.querySelector(".better").append("→ ", pressableText(c.natural));
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "play") return speak(c.natural);
      if (b.dataset.act === "add") {
        addItem(c.natural, c.meaning_ja);
        b.disabled = true;
        b.textContent = "✓ ストックしました";
      }
    });
    list.append(el);
  });
}

// ---------- 設定 ----------
$("#api-key").value = settings.apiKey;
$("#model").value = settings.model;
$("#rate").value = settings.rate;
$("#rate-val").textContent = `×${settings.rate}`;
$("#accent").value = settings.accent;

$("#api-key").addEventListener("change", (e) => {
  // コピー時に混ざった空白・改行を取り除く
  settings.apiKey = e.target.value.replace(/\s+/g, "");
  e.target.value = settings.apiKey;
  saveSettings();
  if (settings.apiKey && !settings.apiKey.startsWith("sk-ant-")) {
    toast("APIキーは「sk-ant-」で始まる文字列です。コピーした内容を確認してください");
  } else {
    toast(`APIキーを保存しました（${settings.apiKey.length}文字）`);
  }
});
$("#model").addEventListener("change", (e) => { settings.model = e.target.value; saveSettings(); });
$("#voice").addEventListener("change", (e) => { settings.voice = e.target.value; saveSettings(); });
$("#rate").addEventListener("input", (e) => {
  settings.rate = +e.target.value;
  $("#rate-val").textContent = `×${settings.rate}`;
  saveSettings();
});
$("#accent").addEventListener("change", (e) => {
  settings.accent = e.target.value;
  settings.voice = pickDefaultVoice()?.name || "";
  $("#voice").value = settings.voice;
  saveSettings();
});
$("#test-voice").addEventListener("click", () => speak("Hey, what's up? I'm gonna grab a coffee. Wanna come?"));

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ items }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `english-notebook-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data.items) ? data.items : [];
    const known = new Set(items.map((i) => i.id));
    const added = incoming
      .filter((i) => i?.id && i?.en && !known.has(i.id))
      .map((i) => ({ ...i, alts: i.alts || [] }));
    items = [...added, ...items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    saveItems();
    toast(`${added.length} 件のストックを読み込みました`);
  } catch {
    toast("読み込めないファイルです");
  }
  e.target.value = "";
});

renderChat();
if (!settings.apiKey) showView("settings");
