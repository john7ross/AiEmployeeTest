/* =========================================================================
 * ОРКЕСТРАЦИЯ ЭКРАНОВ: код -> приветствие -> опрос -> благодарность
 * Вопросы/принципы/промпт приходят из таблицы (API.getSurvey).
 * ========================================================================= */
window.App = (function () {
  const C = window.CONFIG;
  const el = (id) => document.getElementById(id);
  let user = null;
  let survey = null;      // { questions, principles, prompt }
  let lastProtocol = '';
  let welcomeTimers = [];

  function init() {
    el('code-submit').onclick = onCode;
    el('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onCode(); });
    el('start-btn').onclick = onStart;
    el('back-btn').onclick = () => Survey.back();
    el('dl-protocol').onclick = downloadProtocol;
    el('copy-prompt').onclick = copyPrompt;
    el('resume-continue').onclick = () => Survey.resume(user, survey.questions);
    el('knowledge-notice-ok').onclick = () => Survey.confirmKnowledgeIntro();
    el('code-input').focus();
  }

  async function onCode() {
    const code = el('code-input').value.trim();
    const err = el('code-error');
    err.classList.add('hidden');
    if (!code) return;

    el('code-submit').disabled = true;
    try {
      const res = await API.validateCode(code);
      if (!res.valid) {
        err.textContent = res.reason === 'used' ? 'Этот код уже использован.'
          : 'Код не найден. Проверьте правильность ввода.';
        err.classList.remove('hidden');
        return;
      }
      // Старый backend без поля timerEnabled сохраняет прежнее поведение.
      user = { id: res.id, fio: res.fio, code, timerEnabled: res.timerEnabled !== false };
      survey = await API.getSurvey(user);
      if (Survey.getSaved(user)) show('screen-resume');
      else showWelcome();
    } catch (e) {
      console.error('Login failed', e);
      err.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
      err.classList.remove('hidden');
    } finally {
      el('code-submit').disabled = false;
    }
  }

  function showWelcome() {
    show('screen-welcome');
    el('welcome-media').innerHTML = mediaHtml(C.welcomeMedia);
    // Пока сотрудник смотрит приветствие и принципы, заранее загружаем первые
    // маскоты. Это не блокирует видео и уменьшает паузу на первых вопросах.
    Survey.preloadMascots(survey.questions.length);
    // Приветствие — сразу (с плавным появлением)
    const hello = el('welcome-hello');
    hello.textContent = C.welcomeHello;
    hello.classList.remove('appear'); void hello.offsetWidth; hello.classList.add('appear');
    // Все элементы сразу занимают место в макете; меняется только видимость.
    // Поэтому центрирование экрана не двигает видео и заголовок вверх.
    const title = el('principles-title');
    title.textContent = C.principlesTitle;
    title.className = 'principles-title reveal-pending';
    revealWelcome(survey.principles || C.principles);
  }

  // Плавная цепочка с коротким интервалом: заголовок → принципы → кнопка.
  function revealWelcome(list) {
    const d = C.principleDelayMs;
    welcomeTimers.forEach(clearTimeout);
    welcomeTimers = [];
    const ul = el('principles'); ul.innerHTML = '';
    const startBtn = el('start-btn'); startBtn.className = 'btn reveal-pending';
    const items = list.map((text) => {
      const li = document.createElement('li');
      li.className = 'reveal-pending';
      const img = document.createElement('img'); img.className = 'principle-mark'; img.src = C.principleMark; img.alt = '';
      const span = document.createElement('span'); span.textContent = text;
      li.appendChild(img); li.appendChild(span); ul.appendChild(li);
      return li;
    });
    const reveal = (node) => {
      node.classList.remove('reveal-pending');
      node.classList.add('appear');
    };
    let step = 0;

    step += 1;                                   // заголовок
    welcomeTimers.push(setTimeout(() => reveal(el('principles-title')), step * d));

    items.forEach((item) => {                    // принципы
      const at = (step += 1) * d;
      welcomeTimers.push(setTimeout(() => reveal(item), at));
    });

    step += 1;                                   // кнопка
    welcomeTimers.push(setTimeout(() => reveal(startBtn), step * d));
  }

  function onStart() {
    el('start-btn').disabled = true;
    Survey.start(user, survey.questions);
  }

  function showThanks(protocolText) {
    lastProtocol = protocolText;
    el('thanks-media').innerHTML = mediaHtml(C.thanksMedia);
    el('thanks-text').textContent = C.thanksText;
    show('screen-thanks');
  }

  function downloadProtocol() {
    const fio = (user && user.fio ? user.fio : 'result').replace(/[^\wа-яё \-]/gi, '').trim().replace(/\s+/g, '_');
    const blob = new Blob([lastProtocol], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Протокол_' + fio + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function copyPrompt() {
    const text = (survey && survey.prompt) || C.aiPromptTemplate;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    el('copy-note').classList.remove('hidden');
  }

  // Разметка медиа: img/gif или video (пробелы в имени файла кодируем).
  function mediaHtml(src) {
    const url = encodeURI(src);
    if (/\.(mp4|webm)$/i.test(src)) return `<video src="${url}" preload="auto" autoplay muted loop playsinline></video>`;
    return `<img src="${url}" alt="" />`;
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
    el(id).classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', init);
  return { showThanks, mediaHtml };
})();
