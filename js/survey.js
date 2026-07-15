/* =========================================================================
 * ДВИЖОК ОПРОСА (динамический набор включённых вопросов)
 * Типы вопросов:
 *   self      — самооценка (511): 4 варианта-уровня, тег level-*, без таймера;
 *   profile   — отношение/интерес/безопасность: A/B/C с портретными тегами
 *               + «Свой вариант» (свободный текст, без тега);
 *   knowledge — навыки (301–310): 4 варианта, правильный ответ, таймер 20 сек.
 * Плюс: статус-бар, «назад» на один шаг, запись каждого ответа, сбор протокола.
 * ========================================================================= */
window.Survey = (function () {
  const C = window.CONFIG;
  let state = null;   // { user, questions, index, frontier, answers, done }
  let timerHandle = null;
  let submitting = false;
  let finalizing = false;
  let saveQueue = Promise.resolve();
  let saveError = null;
  const mascotPreload = [];
  const mascotPreloadAhead = 4;
  let mascotRequestId = 0;

  const el = (id) => document.getElementById(id);
  const blockCfg = (id) => C.blocks.find((b) => b.id === id) || {};

  // Детерминированная композиция: сторона, вертикальное выравнивание, небольшой
  // сдвиг и наклон. При возврате к вопросу картинка остаётся на том же месте.
  const POS = [
    { side: 'side-left',  align: 'mascot-high',   x: '-18px', y: '-20px', tilt: '-5deg' },
    { side: 'side-right', align: 'mascot-low',    x: '18px',  y: '22px',  tilt: '6deg' },
    { side: 'side-left',  align: 'mascot-center', x: '-12px', y: '8px',   tilt: '3deg' },
    { side: 'side-right', align: 'mascot-high',   x: '12px',  y: '-18px', tilt: '-4deg' },
    { side: 'side-left',  align: 'mascot-low',    x: '-8px',  y: '24px',  tilt: '7deg' },
    { side: 'side-right', align: 'mascot-center', x: '20px',  y: '-4px',  tilt: '-2deg' },
    { side: 'side-left',  align: 'mascot-high',   x: '-10px', y: '-24px', tilt: '4deg' },
    { side: 'side-right', align: 'mascot-low',    x: '10px',  y: '18px',  tilt: '-6deg' },
  ];

  function start(user, questions) {
    // Всегда свежий проход. Без авто-резюма из localStorage: иначе повторный вход
    // по тому же коду показывал вопрос «с середины» (незавершённый прогресс).
    state = {
      user, questions, questionSetKey: makeQuestionSetKey(questions),
      index: 0, frontier: 0, answers: {}, done: false, knowledgeIntroSeen: false,
    };
    resetSaveQueue();
    persist();
    show('screen-survey');
    el('progress').classList.remove('hidden');
    render();
  }

  function render() {
    stopTimer();
    const q = state.questions[state.index];
    if (needsKnowledgeIntro(q)) {
      showKnowledgeIntro();
      return;
    }
    el('knowledge-notice').classList.add('hidden');
    const bc = blockCfg(q.block);
    const answered = state.answers[q.id];
    const isFrontier = state.index === state.frontier;

    // Первые 32 маскота уникальны, затем набор циклически повторяется.
    const pos = POS[state.index % POS.length];
    const stage = document.querySelector('.survey-stage');
    stage.className = 'survey-stage ' + pos.side + ' ' + pos.align;
    const mascot = el('q-mascot');
    const requestedMascot = mascotUrl(state.index);
    const requestId = ++mascotRequestId;
    mascot.classList.add('mascot-loading');
    const markMascotAspect = () => {
      if (requestId !== mascotRequestId) return;
      mascot.classList.toggle('mascot-wide', mascot.naturalWidth > mascot.naturalHeight * 1.35);
      mascot.classList.remove('mascot-loading');
    };
    mascot.classList.remove('mascot-wide');
    mascot.onload = markMascotAspect;
    mascot.onerror = () => {
      if (requestId === mascotRequestId) mascot.classList.remove('mascot-loading');
    };
    mascot.src = requestedMascot;
    if (mascot.complete && mascot.naturalWidth) markMascotAspect();
    preloadMascotRange(state.index + 1, mascotPreloadAhead, state.questions.length);
    mascot.style.setProperty('--mascot-x', pos.x);
    mascot.style.setProperty('--mascot-y', pos.y);
    mascot.style.setProperty('--mascot-tilt', pos.tilt);
    setProgress(state.index / state.questions.length);
    el('q-text').textContent = q.text;

    const back = el('back-btn');
    back.classList.toggle('hidden', !(isFrontier && state.index > 0));

    // На текущем вопросе знаний таймер обязателен. При просмотре предыдущего
    // уже отвеченного вопроса ответ остаётся заблокированным, но таймер не нужен.
    const reviewingKnowledge = q.block === 'knowledge' && !!answered && !isFrontier;
    const useTimer = state.user.timerEnabled !== false && !!bc.timed && !reviewingKnowledge;
    renderBody(q, bc, answered, useTimer, reviewingKnowledge);
  }

  function mascotUrl(index) {
    const count = Math.max(1, Number(C.mascotCount) || 32);
    return 'assets/mascot/' + ((index % count) + 1) + '.png';
  }

  function preloadMascotRange(start, count, total) {
    const end = Math.min(total, start + count);
    for (let index = Math.max(0, start); index < end; index += 1) {
      if (mascotPreload[index]) continue;
      const image = document.createElement('img');
      image.src = mascotUrl(index);
      mascotPreload[index] = image;
    }
  }

  function preloadMascots(total) {
    preloadMascotRange(0, mascotPreloadAhead + 1, total);
  }

  function needsKnowledgeIntro(q) {
    if (!q || q.block !== 'knowledge' || state.knowledgeIntroSeen || state.user.timerEnabled === false) return false;
    return state.questions.findIndex((item) => item.block === 'knowledge') === state.index;
  }

  function showKnowledgeIntro() {
    el('knowledge-notice').classList.remove('hidden');
    el('knowledge-notice-ok').focus();
  }

  function confirmKnowledgeIntro() {
    if (!state || !needsKnowledgeIntro(state.questions[state.index])) return;
    state.knowledgeIntroSeen = true;
    persist();
    el('knowledge-notice').classList.add('hidden');
    render();
  }

  function renderBody(q, bc, answered, useTimer, reviewingKnowledge) {
    const body = el('q-body');
    body.innerHTML = '';
    el('q-hint').textContent = '';
    el('q-timer').classList.add('hidden');

    // Блок знаний: уже отвечённый вопрос при возврате назад — ТОЛЬКО просмотр
    // (защита от гугления). Перевыбрать нельзя.
    const locked = bc.scored && !!answered;

    (q.options || []).forEach((opt) => {
      const b = document.createElement('button');
      b.className = 'option';
      b.textContent = opt.text;
      if (answered && answered.value === opt.key) b.classList.add('selected');
      if (locked) b.disabled = true;
      else b.onclick = () => choose(q, bc, opt);
      body.appendChild(b);
    });

    // «Свой вариант» — только для profile-вопросов
    if (q.type === 'profile' && q.allowOwn && !locked) {
      const ownWrap = document.createElement('div');
      ownWrap.className = 'own-wrap';
      const toggle = document.createElement('button');
      toggle.className = 'option own-toggle';
      toggle.textContent = '✎ Свой вариант';
      if (answered && answered.own != null) toggle.classList.add('selected');
      ownWrap.appendChild(toggle);
      body.appendChild(ownWrap);

      const openOwn = () => {
        if (ownWrap.querySelector('textarea')) return;
        const ta = document.createElement('textarea');
        ta.className = 'answer-text';
        ta.rows = 3;
        ta.placeholder = 'Впишите свой ответ…';
        if (answered && answered.own != null) ta.value = answered.own;
        ownWrap.appendChild(ta);
        el('q-hint').textContent = 'Enter — далее · Shift+Enter — новая строка';
        ta.focus();
        ta.onkeydown = (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const v = ta.value.trim();
            if (v) submitOwn(q, v);
          }
        };
      };
      toggle.onclick = openOwn;
      if (answered && answered.own != null) openOwn();
    }

    if (reviewingKnowledge) {
      const returnButton = document.createElement('button');
      returnButton.className = 'btn review-return';
      returnButton.textContent = 'Вернуться к текущему вопросу';
      returnButton.onclick = returnToFrontier;
      body.appendChild(returnButton);
      el('q-hint').textContent = 'Ответ уже сохранён и недоступен для изменения.';
    }

    if (useTimer) startTimer(bc.timerSeconds, () => onTimeout(q, bc));
  }

  // --- ответы ---
  function choose(q, bc, opt) {
    if (submitting) return;
    submitting = true;
    const data = { value: opt.key, own: null };
    if (q.type === 'knowledge') data.correct = (opt.key === q.correct);
    if (opt.tag) data.tag = opt.tag;
    record(q, data);
    advance();
  }
  function submitOwn(q, text) {
    if (submitting) return;
    submitting = true;
    record(q, { value: null, own: text, tag: null });
    advance();
  }
  function onTimeout(q, bc) {
    if (submitting) return;
    submitting = true;
    if (!state.answers[q.id]) {
      record(q, { value: null, correct: bc.scored ? false : undefined, timedOut: true });
    }
    advance();
  }

  function record(q, data) {
    state.answers[q.id] = Object.assign({ block: q.block, type: q.type }, data);
    persist();
    const payload = {
      id: state.user.id, code: state.user.code,
      questionId: q.id, block: q.block,
      answer: data.own != null ? data.own : data.value,
    };
    // Интерфейс не ждёт медленный Apps Script. Запросы идут строго по одному,
    // а атомарный finish при необходимости восстановит всё локальное состояние.
    saveQueue = saveQueue
      // После первой ошибки не отправляем оставшиеся десятки запросов в уже
      // перегруженный Apps Script. Все ответы восстановит атомарный finish.
      .then(() => finalizing || saveError ? { ok: false, deferred: true } : API.saveAnswer(payload))
      .then((saved) => {
        if (saved && saved.deferred) return;
        if (!saved || !saved.ok) throw new Error('Ответ ' + q.id + ' не сохранён');
      })
      .catch((error) => {
        saveError = error;
        console.warn('Background save failed', error);
        const hint = el('q-hint');
        if (hint) hint.textContent = 'Один из ответов не сохранился. Проверьте соединение.';
      });
  }

  function resetSaveQueue() {
    saveQueue = Promise.resolve();
    saveError = null;
    finalizing = false;
  }

  // --- навигация (назад ровно на один шаг) ---
  function advance() {
    stopTimer();
    if (state.index >= state.questions.length - 1) return finish();
    submitting = false;
    state.index += 1;
    if (state.index > state.frontier) state.frontier = state.index;
    persist();
    render();
  }
  function back() {
    if (state.index === 0) return;
    stopTimer();
    state.index -= 1;
    persist();
    render();
  }
  function returnToFrontier() {
    stopTimer();
    state.index = state.frontier;
    persist();
    render();
  }

  async function finish() {
    if (finalizing) return;
    finalizing = true;
    stopTimer();
    setProgress(1);
    el('back-btn').classList.add('hidden');
    el('q-hint').textContent = 'Завершаем опрос…';
    const answers = state.questions.map((q) => {
      const answer = state.answers[q.id] || {};
      return {
        questionId: q.id,
        answer: answer.own != null ? answer.own : answer.value,
      };
    });
    const res = computeResults();
    // Один идемпотентный backend-вызов синхронизирует ответы, записывает итоги
    // и только последним действием переводит токен в «Использован».
    let saved = await API.finish({
      id: state.user.id,
      code: state.user.code,
      answers,
      results: res,
    });
    // Callback мог потеряться уже после успешной записи. В таком случае
    // завершённый токен — надёжное подтверждение, что итоги записаны.
    if (!saved || !saved.ok) {
      try {
        const status = await API.validateCode(state.user.code);
        if (status && status.valid === false && status.reason === 'used') saved = { ok: true, confirmed: true };
      } catch (error) {
        console.warn('Finish confirmation failed', error);
      }
    }
    if (!saved || !saved.ok) {
      finalizing = false;
      submitting = false;
      setProgress(state.index / state.questions.length);
      el('back-btn').classList.remove('hidden');
      el('q-hint').textContent = 'Не удалось завершить опрос. Проверьте соединение и нажмите последний ответ ещё раз.';
      return;
    }
    saveError = null;
    state.done = true;
    persist();
    App.showThanks(buildProtocol());
    el('progress').classList.add('hidden');
  }

  // --- подсчёт: % правильных, самооценка, портрет ---
  function computeResults() {
    // знания
    const kn = state.questions.filter((q) => q.type === 'knowledge');
    const correct = kn.filter((q) => state.answers[q.id] && state.answers[q.id].correct === true).length;
    const percentCorrect = kn.length ? Math.round((correct / kn.length) * 100) : 0;

    // самооценка (511)
    const selfQ = state.questions.find((q) => q.type === 'self');
    let selfScore = null;
    if (selfQ && state.answers[selfQ.id]) selfScore = C.selfScore[state.answers[selfQ.id].tag];

    const profile = calculateProfile(state.questions, state.answers);
    return Object.assign({ correct, total: kn.length, percentCorrect, selfScore }, profile);
  }

  function calculateProfile(questions, answers) {
    const P = C.portrait;
    const values = {};
    Object.keys(P.dimensions).forEach((key) => { values[key] = []; });

    questions.forEach((q) => {
      const answer = answers[q.id];
      if (!answer || answer.value == null) return; // свой вариант не получает выдуманный вес
      const weighted = P.scores[q.id] && P.scores[q.id][answer.value];
      if (!weighted) return;
      Object.keys(P.dimensions).forEach((key) => {
        if (Number.isFinite(weighted[key])) values[key].push(weighted[key]);
      });
    });

    const result = {};
    let weightedTotal = 0;
    let weightTotal = 0;
    let sufficient = true;
    Object.keys(P.dimensions).forEach((key) => {
      const cfg = P.dimensions[key];
      const vals = values[key];
      const score = vals.length >= cfg.minAnswers
        ? Math.round(vals.reduce((sum, value) => sum + value, 0) / vals.length)
        : null;
      result[cfg.resultKey] = score;
      if (score == null) sufficient = false;
      else {
        weightedTotal += score * cfg.weight;
        weightTotal += cfg.weight;
      }
    });

    result.portraitScore = sufficient && weightTotal > 0
      ? Math.round(weightedTotal / weightTotal)
      : null;
    result.portraitLabel = result.portraitScore == null
      ? ''
      : ((P.thresholds.find((t) => result.portraitScore <= t.max) || {}).label || '');
    return result;
  }

  // --- протокол для скачивания ---
  // Только ФИО + «вопрос → ответ пользователя». Без ID, итогов, названий блоков и
  // правильных ответов: оценки/портрет — внутренние, а ключ нельзя раздавать коллегам.
  function buildProtocol() {
    const L = [];
    L.push('Протокол опроса');
    L.push('Сотрудник: ' + (state.user.fio || ''));
    L.push('Дата прохождения: ' + new Date().toLocaleString('ru-RU'));
    L.push('');
    state.questions.forEach((q, i) => {
      const a = state.answers[q.id] || {};
      const ans = a.own != null ? a.own
        : (a.value != null ? optText(q, a.value)
        : (a.timedOut ? '(не успел ответить)' : '(нет ответа)'));
      L.push((i + 1) + '. ' + q.text);
      L.push('Ответ: ' + ans);
      L.push('');
    });
    return L.join('\n');
  }
  function optText(q, key) {
    const o = (q.options || []).find((x) => x.key === key);
    return o ? o.text : '';
  }

  // --- таймер ---
  function startTimer(seconds, onEnd) {
    const t = el('q-timer');
    t.classList.remove('hidden');
    let left = seconds; t.textContent = left;
    timerHandle = setInterval(() => {
      left -= 1; t.textContent = left;
      if (left <= 0) { stopTimer(); onEnd(); }
    }, 1000);
  }
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }

  function setProgress(frac) {
    el('progress-fill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  }

  function persist() { try { localStorage.setItem(progKeyFor(state.user.code), JSON.stringify(state)); } catch {} }
  function progKeyFor(code) { return C.progressKey + ':' + code; }
  function makeQuestionSetKey(questions) {
    return JSON.stringify((questions || []).map((q) => String(q.id)));
  }

  // Незавершённый сохранённый проход под этим кодом (для «Продолжить»).
  function getSaved(user, questions) {
    try {
      const raw = localStorage.getItem(progKeyFor(user.code));
      if (!raw) return null;
      const s = JSON.parse(raw);
      const savedSetKey = s && (s.questionSetKey || makeQuestionSetKey(s.questions));
      return (s && s.user && s.user.code === user.code && !s.done && s.index > 0 &&
        savedSetKey === makeQuestionSetKey(questions)) ? s : null;
    } catch { return null; }
  }
  // Продолжить с сохранённого места (вопросы берём свежие из таблицы).
  function resume(user, questions) {
    const s = getSaved(user, questions);
    if (!s) return start(user, questions);
    state = {
      user, questions, questionSetKey: makeQuestionSetKey(questions), index: s.index, frontier: s.frontier,
      answers: s.answers || {}, done: false,
      knowledgeIntroSeen: s.knowledgeIntroSeen === true,
    };
    resetSaveQueue();
    show('screen-survey');
    el('progress').classList.remove('hidden');
    if (questions.every((q) => !!state.answers[q.id])) {
      submitting = true;
      finish();
      return;
    }
    render();
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
    el(id).classList.remove('hidden');
  }

  return { start, back, resume, getSaved, calculateProfile, confirmKnowledgeIntro, preloadMascots };
})();
