/* =========================================================================
 * API — общение с Google Apps Script по JSONP (обход CORS).
 * Источник ВСЕГО (вопросы, принципы, промпт) — Google-таблица.
 * В DEMO_MODE берём офлайн-фолбэк из questions.js / config.js.
 * ========================================================================= */
window.API = (function () {
  const C = window.CONFIG;
  let jsonpSeq = 0;

  function jsonp(params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!C.API_URL) return reject(new Error('API_URL не задан'));
      const cb = '__survey_cb_' + (++jsonpSeq) + '_' + Date.now();
      const url = C.API_URL + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString();
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('Таймаут запроса')); }, timeoutMs || 30000);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (script.parentNode) script.parentNode.removeChild(script); }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('Ошибка сети')); };
      script.src = url;
      document.body.appendChild(script);
    });
  }

  // --- Проверка кода. Завершённый код блокируется на стороне таблицы. ---
  async function validateCode(code) {
    if (C.DEMO_MODE) {
      if (code.trim() === C.DEMO_CODE) return { valid: true, id: 1, fio: 'Тестов Тест Тестович' };
      return { valid: false, reason: 'not_found' };
    }
    return readWithRetry({ action: 'validateCode', code });
  }

  // --- Весь опрос из таблицы: повторная проверка ID + токена обязательна. ---
  async function getSurvey(user) {
    if (C.DEMO_MODE) {
      return { questions: window.DEMO_QUESTIONS, principles: C.principles, prompt: C.aiPromptTemplate };
    }
    if (!user || user.id == null || !user.code) throw new Error('Не заданы данные доступа к опросу');
    const res = await readWithRetry({ action: 'getSurvey', id: user.id, code: user.code });
    if (!res || res.ok !== true) throw new Error(res && res.error || 'Доступ к опросу не подтверждён');
    const survey = {
      questions: res.questions || [],
      principles: res.principles || C.principles,
      prompt: res.prompt || C.aiPromptTemplate,
    };
    return survey;
  }

  // --- Запись одного ответа; первый сохранённый ответ ставит статус «Частично». ---
  function saveAnswer(payload) {
    if (C.DEMO_MODE) { console.log('[demo] saveAnswer', payload); return Promise.resolve({ ok: true }); }
    return jsonp(Object.assign({ action: 'saveAnswer' }, serialize(payload)))
      .catch((e) => { console.warn('saveAnswer failed', e); return { ok: false }; });
  }

  // --- Идемпотентная финальная синхронизация всех локальных ответов. ---
  // Нужна для восстановления после таймаута одного из фоновых saveAnswer.
  function saveAnswers(payload) {
    if (C.DEMO_MODE) { console.log('[demo] saveAnswers', payload); return Promise.resolve({ ok: true }); }
    return writeWithRetry(Object.assign({ action: 'saveAnswers' }, serialize(payload)));
  }

  // --- Финализация: внутренние итоги (процент, самооценка, портрет) в строку сотрудника. ---
  function finish(payload) {
    if (C.DEMO_MODE) { console.log('[demo] finish', payload); return Promise.resolve({ ok: true }); }
    return writeWithRetry(Object.assign({ action: 'finish' }, serialize(payload)));
  }

  function serialize(p) {
    const out = {};
    for (const k in p) out[k] = (typeof p[k] === 'object') ? JSON.stringify(p[k]) : p[k];
    return out;
  }
  async function readWithRetry(params) {
    try { return await jsonp(params); }
    catch (firstError) {
      console.warn('Read request failed, retrying once', firstError);
      return jsonp(params);
    }
  }
  // Batch-синхронизация и finish идемпотентны, поэтому один повтор после
  // сетевого таймаута безопаснее, чем оставлять токен в состоянии «Частично».
  async function writeWithRetry(params) {
    try {
      const first = await jsonp(params, 60000);
      if (first && first.ok === true) return first;
      throw new Error(first && (first.reason || first.error) || 'Запись отклонена');
    } catch (firstError) {
      console.warn('Write request failed, retrying once', firstError);
      try { return await jsonp(params, 60000); }
      catch (secondError) {
        console.warn('Write request failed', secondError);
        return { ok: false };
      }
    }
  }
  return { validateCode, getSurvey, saveAnswer, saveAnswers, finish };
})();
