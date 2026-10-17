import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";

// ---------- 保存 ----------
const ITEMS_KEY = "een.items";
const SETTINGS_KEY = "een.settings";

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

let items = load(ITEMS_KEY, []);
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
  if (name === "talk" && !talk.active) renderPicks();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

// ---------- Claude ----------
// サーバー側フォールバック（安全分類器が拒否した時に別モデルで再実行）に対応するモデル
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// onText を渡すとストリーミングで受け取り、届いた分のテキストを都度渡す
async function callClaude({ system, messages, effort = "low", schema, maxTokens = 4000, onText }) {
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

  const useBeta = FALLBACK_MODELS.has(settings.model);
  const body = useBeta
    ? { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
    : params;
  const api = useBeta ? client.beta.messages : client.messages;

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
    rec.interimResults = false;
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

async function pronunciationCheck(item, button, outEl) {
  try {
    toast("どうぞ、英文を言ってください");
    const r = await listen(ACCENT_LANG[settings.accent] || "en-US", button);
    if (!r) return;
    const best = r.alternatives
      .map((a) => ({ a, ...compareSpeech(item.en, a) }))
      .sort((x, y) => y.score - x.score)[0];
    item.stats = item.stats || { plays: 0, checks: 0, best: 0 };
    item.stats.checks++;
    item.stats.best = Math.max(item.stats.best || 0, best.score);
    item.stats.last = best.score;
    saveItems();
    const words = best.marks.map((m) => `<span class="${m.ok ? "w-ok" : "w-miss"}">${esc(m.w)}</span>`).join(" ");
    const msg = best.score >= 90 ? "すばらしい！ネイティブに伝わります" : best.score >= 70 ? "いい感じ！赤い単語を意識してもう一度" : "赤い単語がうまく伝わっていません。お手本を聞いてから再挑戦";
    outEl.innerHTML = `<div class="check-result"><b>${best.score}点</b> — ${msg}<br>${words}<br><span class="muted small">聞き取られた文: “${esc(best.a)}”</span></div>`;
  } catch (e) {
    toast(errMessage(e));
  }
}

// ---------- 翻訳（教材づくり） ----------
const PHRASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["english", "sounds_like", "sounds_like_kana", "pronunciation_tips", "key_phrases", "alternatives", "scene"],
  properties: {
    english: { type: "string" },
    sounds_like: { type: "string" },
    sounds_like_kana: { type: "string" },
    pronunciation_tips: { type: "array", items: { type: "string" } },
    key_phrases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "meaning"],
        properties: { phrase: { type: "string" }, meaning: { type: "string" } },
      },
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["english", "nuance"],
        properties: { english: { type: "string" }, nuance: { type: "string" } },
      },
    },
    scene: { type: "string" },
  },
};

function translateSystem() {
  return `You turn a Japanese learner's everyday Japanese into the English a native ${settings.accent} speaker would actually say in the same situation — casual, spoken, natural. Avoid textbook or overly literal translations; use the contractions, phrasal verbs and idioms natives really use, while keeping the speaker's tone (casual stays casual, polite stays polite).

The learner cares most about pronunciation, so describe how the sentence really sounds at natural speed.

Fields:
- english: the single most natural way to say it.
- sounds_like: a respelling of how it sounds at natural speed, showing linking and reductions, with STRESSED syllables in capitals, e.g. "I'm GONna GRAB a BITE" -> "aim-GONna-GRA-buh-BITE".
- sounds_like_kana: the same sound written in katakana for a Japanese reader, stressed parts marked with ＊ before them.
- pronunciation_tips: 2-4 short tips in Japanese about linking, reductions, flap T, stress and intonation specific to this sentence.
- key_phrases: the reusable chunks in the sentence with Japanese meanings.
- alternatives: 1-3 other natural ways to say it, each with its nuance in Japanese (who would say it, how casual).
- scene: a short Japanese label for the situation (e.g. "友達との予定").`;
}

// ストリーミング途中のJSONから、書き終わった "english" の値を取り出す
function earlyEnglish(partial) {
  const m = partial.match(/"english"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

async function translate(ja, context, fixedEnglish, onEnglish) {
  let prompt = `Japanese: ${ja}`;
  if (context) prompt += `\nSituation: ${context}`;
  if (fixedEnglish) prompt += `\nUse exactly this English as the main expression: ${fixedEnglish}`;
  const { text } = await callClaude({
    system: translateSystem(),
    messages: [{ role: "user", content: prompt }],
    effort: "low",
    schema: PHRASE_SCHEMA,
    onText: onEnglish
      ? (soFar) => {
          if (!onEnglish) return;
          const en = earlyEnglish(soFar);
          if (en) {
            onEnglish(en);
            onEnglish = null;
          }
        }
      : undefined,
  });
  const data = parseJson(text);
  return {
    id: uid(),
    ja,
    context: context || "",
    en: data.english,
    soundsLike: data.sounds_like,
    soundsLikeKana: data.sounds_like_kana,
    tips: data.pronunciation_tips,
    keyPhrases: data.key_phrases,
    alternatives: data.alternatives,
    scene: data.scene,
    createdAt: Date.now(),
    stats: { plays: 0, checks: 0, best: 0 },
  };
}

$("#translate-btn").addEventListener("click", async () => {
  const ja = $("#ja-input").value.trim();
  if (!ja) return toast("日本語を入力してください");
  const btn = $("#translate-btn");
  btn.disabled = true;
  $("#translate-result").innerHTML = `<p class="spinner">ネイティブ表現を考えています…</p>`;
  try {
    let spoken = null;
    // 英文ができた時点で先に表示・読み上げ（発音のコツなどは後から届く）
    const item = await translate(ja, $("#ctx-input").value.trim(), "", (en) => {
      spoken = en;
      $("#translate-result").innerHTML = `<div class="card phrase"><div class="ja">${esc(ja)}</div><div class="en">${esc(en)}</div><p class="spinner">発音のコツ・言い換えを準備中…</p></div>`;
      speak(en);
    });
    items.unshift(item);
    saveItems();
    $("#ja-input").value = "";
    $("#ctx-input").value = "";
    $("#translate-result").innerHTML = "";
    $("#translate-result").append(phraseCard(item, { fresh: true }));
    if (spoken !== item.en) speak(item.en);
  } catch (e) {
    $("#translate-result").innerHTML = "";
    toast(errMessage(e));
  } finally {
    btn.disabled = false;
  }
});

$("#ja-mic").addEventListener("click", async (e) => {
  try {
    const r = await listen("ja-JP", e.currentTarget);
    if (r) $("#ja-input").value = ($("#ja-input").value + " " + r.transcript).trim();
  } catch (err) {
    toast(errMessage(err));
  }
});

// ---------- 教材カード ----------
function phraseCard(item, { fresh = false } = {}) {
  const el = document.createElement("div");
  el.className = "card phrase";
  const alts = (item.alternatives || [])
    .map(
      (a, i) =>
        `<div class="alt"><button class="btn small" data-alt="${i}">▶</button> <b>${esc(a.english)}</b><br><span class="muted small">${esc(a.nuance)}</span></div>`
    )
    .join("");
  const s = item.stats || {};
  el.innerHTML = `
    ${item.scene ? `<span class="tag">${esc(item.scene)}</span>` : ""}${item.source === "feedback" ? `<span class="tag">会話から</span>` : ""}
    <div class="ja">${esc(item.ja)}</div>
    <div class="en">${esc(item.en)}</div>
    ${item.soundsLike ? `<div class="sounds">🔊 ${esc(item.soundsLike)}</div>` : ""}
    ${item.soundsLikeKana ? `<div class="sounds-ja">${esc(item.soundsLikeKana)}</div>` : ""}
    <div class="player">
      <button class="btn small" data-act="play">▶ 再生</button>
      <button class="btn small" data-act="slow">🐢 ゆっくり</button>
      <button class="btn small" data-act="repeat">🔁 3回リピート</button>
      <button class="btn small" data-act="stop">■</button>
      <button class="btn small" data-act="check">🎤 発音チェック</button>
      <button class="btn small" data-act="talk">💬 これで会話</button>
    </div>
    <div class="check-out"></div>
    <details ${fresh ? "open" : ""}>
      <summary>発音のコツ・使えるフレーズ・言い換え</summary>
      ${item.tips?.length ? `<p class="label small">発音のコツ</p><ul>${item.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${item.keyPhrases?.length ? `<p class="label small">使えるフレーズ</p><ul>${item.keyPhrases.map((k) => `<li><b>${esc(k.phrase)}</b> — ${esc(k.meaning)}</li>`).join("")}</ul>` : ""}
      ${alts ? `<p class="label small">他の言い方</p>${alts}` : ""}
      <div class="row"><button class="btn small danger" data-act="delete">削除</button></div>
    </details>
    <div class="stats">再生 ${s.plays || 0}回 ・ 発音チェック ${s.checks || 0}回${s.checks ? ` ・ ベスト ${s.best}点` : ""}</div>
  `;
  const bump = () => {
    item.stats = item.stats || { plays: 0, checks: 0, best: 0 };
    item.stats.plays++;
    saveItems();
  };
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.alt !== undefined) return speak(item.alternatives[+btn.dataset.alt].english);
    switch (btn.dataset.act) {
      case "play": stopSpeaking(); bump(); return speak(item.en);
      case "slow": stopSpeaking(); bump(); return speak(item.en, { rate: Math.max(0.5, settings.rate * 0.65) });
      case "repeat": bump(); return speakRepeat(item.en, 3);
      case "stop": return stopSpeaking();
      case "check": return pronunciationCheck(item, btn, el.querySelector(".check-out"));
      case "talk": return startTalk([item.id]);
      case "delete":
        if (confirm("この教材を削除しますか？")) {
          items = items.filter((x) => x.id !== item.id);
          saveItems();
          el.remove();
          renderLibraryCount();
        }
    }
  });
  return el;
}

function renderLibraryCount() {
  $("#lib-count").textContent = items.length ? `教材 ${items.length} 件` : "";
}

function renderLibrary() {
  const q = $("#search").value.trim().toLowerCase();
  const list = $("#library-list");
  list.innerHTML = "";
  renderLibraryCount();
  if (!items.length) {
    list.innerHTML = `<div class="card muted">まだ教材がありません。「＋ 追加」で普段の日本語を英語にしてみましょう。</div>`;
    return;
  }
  items
    .filter((it) => !q || `${it.ja} ${it.en} ${it.scene}`.toLowerCase().includes(q))
    .forEach((it) => list.append(phraseCard(it)));
}
$("#search").addEventListener("input", renderLibrary);

// ---------- 会話 ----------
const talk = { active: false, targets: [], history: [], log: [], busy: false };

function renderPicks() {
  const box = $("#talk-picks");
  $("#talk-setup").hidden = false;
  if (!items.length) {
    box.innerHTML = `<p class="muted">教材がまだないので、フリートークになります。</p>`;
    return;
  }
  box.innerHTML = items
    .slice(0, 30)
    .map(
      (it) =>
        `<label class="pick"><input type="checkbox" value="${it.id}"><span><b>${esc(it.en)}</b><br><span class="muted small">${esc(it.ja)}</span></span></label>`
    )
    .join("");
}

$("#start-talk").addEventListener("click", () => {
  const ids = [...document.querySelectorAll("#talk-picks input:checked")].map((i) => i.value);
  startTalk(ids);
});

function talkSystem() {
  const list = talk.targets.length
    ? talk.targets.map((t) => `- "${t.en}" (meaning: ${t.ja})`).join("\n")
    : "(none — just have a friendly casual chat about everyday life)";
  return `You are a friendly native ${settings.accent} English speaker chatting with a Japanese learner who wants to sound like a native and is practicing speaking out loud. Your replies are read aloud by text-to-speech.

Target phrases the learner is practicing:
${list}

How to run the conversation:
- Set up a realistic, everyday scene where the target phrases fit naturally. Use them yourself now and then so the learner hears them in context, and steer toward moments where the learner can say them.
- Talk the way natives really talk: contractions, casual phrasing, natural reactions ("Oh nice!", "No way", "Gotcha").
- Keep each reply short: 1-3 spoken sentences, usually ending with a question or prompt that is easy to answer.
- Reply in English only, every single time. If the learner writes or speaks Japanese, understand it and keep going in English — like a friend would, you can naturally check what they meant in English ("Oh, you mean you're beat?") and carry on. Never reply in Japanese and never translate into Japanese.
- Don't correct mistakes or teach during the conversation; the learner gets feedback afterwards. Just respond to what they meant.
- The learner's messages come from speech recognition, so ignore missing punctuation and obvious mis-hearings.
- Plain spoken text only: no markdown, lists, emoji, or stage directions.`;
}

async function startTalk(ids) {
  let targets = items.filter((it) => ids.includes(it.id));
  if (!targets.length) targets = items.slice(0, 5);
  Object.assign(talk, { active: true, targets, history: [], log: [], busy: false });
  showView("talk");
  $("#talk-setup").hidden = true;
  $("#feedback").hidden = true;
  $("#talk-room").hidden = false;
  $("#chat").innerHTML = "";
  $("#talk-targets").innerHTML = targets.length
    ? `<span class="muted small">今日のフレーズ：</span><br>` + targets.map((t) => `<span class="tag">${esc(t.en)}</span>`).join(" ")
    : `<span class="muted small">フリートーク</span>`;
  // 最初のユーザーターンは画面に出さない「開始の合図」
  await sendToAI("(Start the conversation now: open the scene with your first line.)", { hidden: true });
}

function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div>${esc(text)}</div>`;
  if (role === "ai") {
    const tools = document.createElement("div");
    tools.className = "tools";
    tools.innerHTML = `<button data-r="1">▶</button> <button data-r="0.7">🐢</button>`;
    tools.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      stopSpeaking();
      speak(text, { rate: settings.rate * +b.dataset.r });
    });
    el.append(tools);
  }
  $("#chat").append(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

async function sendToAI(userText, { hidden = false } = {}) {
  if (talk.busy) return;
  talk.busy = true;
  if (!hidden) {
    addBubble("me", userText);
    talk.log.push({ role: "learner", text: userText });
  }
  talk.history.push({ role: "user", content: userText });
  const typing = addBubble("ai typing", "…");
  try {
    const { content, text } = await callClaude({
      system: talkSystem(),
      messages: talk.history,
      effort: "low",
      maxTokens: 2000,
    });
    // 返ってきた content はそのまま履歴に積む（思考ブロックも含めて改変しない）
    talk.history.push({ role: "assistant", content });
    typing.remove();
    addBubble("ai", text);
    talk.log.push({ role: "partner", text });
    speak(text);
  } catch (e) {
    typing.remove();
    talk.history.pop();
    if (!hidden) talk.log.pop();
    toast(errMessage(e));
  } finally {
    talk.busy = false;
  }
}

$("#send").addEventListener("click", () => {
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

async function micSend(lang, btn) {
  try {
    const r = await listen(lang, btn);
    if (r?.transcript) sendToAI(r.transcript);
  } catch (e) {
    toast(errMessage(e));
  }
}
$("#mic-en").addEventListener("click", (e) => micSend(ACCENT_LANG[settings.accent] || "en-US", e.currentTarget));
$("#mic-ja").addEventListener("click", (e) => micSend("ja-JP", e.currentTarget));

// ---------- フィードバック ----------
const FEEDBACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "good_points", "corrections", "target_usage"],
  properties: {
    summary: { type: "string" },
    good_points: { type: "array", items: { type: "string" } },
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
    target_usage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "used", "comment"],
        properties: { phrase: { type: "string" }, used: { type: "boolean" }, comment: { type: "string" } },
      },
    },
  },
};

const FEEDBACK_SYSTEM = `You are an expert English coach for Japanese learners who want to sound like natural native speakers. You review a finished practice conversation and give feedback in Japanese.

The learner's lines came through speech recognition: ignore punctuation, capitalization and obvious mis-hearings; judge only word choice, grammar and naturalness.

- corrections: every learner line that a native would find unnatural, wrong, or overly textbook-like. Give what they said, the natural way a native would say it in that moment, its Japanese meaning, kind ("grammar" for errors, "unnatural" for correct-but-odd), and a short Japanese explanation of why. For lines the learner said in Japanese, use kind "japanese" and give the natural English they could have said. Skip lines that are already natural.
- good_points: specific things they did well, in Japanese.
- target_usage: for each target phrase, whether the learner used it and a short Japanese comment.
- summary: 2-3 encouraging Japanese sentences on overall impression and the one thing to focus on next.`;

$("#end-talk").addEventListener("click", async () => {
  stopSpeaking();
  if (!talk.log.some((l) => l.role === "learner")) {
    talk.active = false;
    $("#talk-room").hidden = true;
    renderPicks();
    return;
  }
  const btn = $("#end-talk");
  btn.disabled = true;
  const fb = $("#feedback");
  fb.hidden = false;
  fb.innerHTML = `<p class="spinner">会話をふり返っています…</p>`;
  $("#talk-room").hidden = true;
  const transcript = talk.log.map((l) => `${l.role === "learner" ? "Learner" : "Partner"}: ${l.text}`).join("\n");
  const targets = talk.targets.map((t) => `- ${t.en}`).join("\n") || "(none)";
  try {
    const { text } = await callClaude({
      system: FEEDBACK_SYSTEM,
      messages: [{ role: "user", content: `Target phrases:\n${targets}\n\nConversation:\n${transcript}` }],
      effort: "medium",
      schema: FEEDBACK_SCHEMA,
      maxTokens: 8000,
    });
    renderFeedback(parseJson(text));
  } catch (e) {
    fb.innerHTML = `<div class="card">フィードバックの作成に失敗しました：${esc(errMessage(e))}</div>`;
  } finally {
    btn.disabled = false;
    talk.active = false;
  }
});

function renderFeedback(data) {
  const fb = $("#feedback");
  const kindLabel = { grammar: "文法", unnatural: "より自然に", japanese: "日本語→英語" };
  fb.innerHTML = `
    <div class="card">
      <p class="label">ふり返り</p>
      <p>${esc(data.summary)}</p>
      ${data.good_points?.length ? `<p class="label small">よかったところ</p><ul>${data.good_points.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
      ${data.target_usage?.length ? `<p class="label small">今日のフレーズ</p><ul>${data.target_usage.map((t) => `<li>${t.used ? "✅" : "⬜"} <b>${esc(t.phrase)}</b> — ${esc(t.comment)}</li>`).join("")}</ul>` : ""}
    </div>
    <p class="label">${data.corrections?.length ? "直したほうがいい表現" : "不自然な表現はありませんでした 🎉"}</p>
    <div id="fb-list"></div>
    <button id="fb-again" class="btn primary wide" type="button">もう一度会話する</button>
  `;
  const list = fb.querySelector("#fb-list");
  (data.corrections || []).forEach((c) => {
    const el = document.createElement("div");
    el.className = `fb-item ${c.kind === "japanese" ? "ja" : ""}`;
    el.innerHTML = `
      <span class="tag">${kindLabel[c.kind] || ""}</span>
      <div class="said">${esc(c.you_said)}</div>
      <div class="better">→ ${esc(c.natural)}</div>
      <div class="muted small">${esc(c.meaning_ja)}</div>
      <div>${esc(c.explanation)}</div>
      <div class="row">
        <button class="btn small" data-act="play">▶ 聞く</button>
        <button class="btn small" data-act="add">＋ 教材に追加</button>
      </div>`;
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "play") return speak(c.natural);
      if (b.dataset.act === "add") {
        b.disabled = true;
        b.textContent = "追加中…";
        try {
          const item = await translate(c.meaning_ja, "", c.natural);
          item.source = "feedback";
          items.unshift(item);
          saveItems();
          b.textContent = "✓ 追加しました";
        } catch (err) {
          b.disabled = false;
          b.textContent = "＋ 教材に追加";
          toast(errMessage(err));
        }
      }
    });
    list.append(el);
  });
  fb.querySelector("#fb-again").addEventListener("click", () => startTalk(talk.targets.map((t) => t.id)));
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
    const added = incoming.filter((i) => i?.id && i?.en && !known.has(i.id));
    items = [...added, ...items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    saveItems();
    toast(`${added.length} 件の教材を読み込みました`);
  } catch {
    toast("読み込めないファイルです");
  }
  e.target.value = "";
});

if (!settings.apiKey) showView("settings");
