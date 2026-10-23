/* Переключатель светлой и тёмной темы. Выбор человека хранится в localStorage;
   пока выбора нет — тема по настройке системы. Скрипт грузится в <head>, чтобы не мигала светлая. */
(function () {
  var KEY = 'ai_survey_theme';
  var root = document.documentElement;
  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* без хранилища выбор живёт до перезагрузки */ } }
  function apply(v) { if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v); else root.removeAttribute('data-theme'); }
  function current() { return root.getAttribute('data-theme') || (mq && mq.matches ? 'dark' : 'light'); }

  apply(stored());

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function refresh() {
      var dark = current() === 'dark';
      btn.innerHTML = dark ? SUN : MOON;
      btn.setAttribute('aria-pressed', String(dark));
      var label = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next); save(next); refresh();
    });
    if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!stored()) refresh(); });
    refresh();
  });
})();
