/* Relay website — small vanilla enhancement layer.
   Every page works with JavaScript disabled; this only adds
   theme memory, the mobile nav, copy buttons, reveals, and TOC highlighting. */

(function () {
  'use strict';

  var STORAGE_KEY = 'relay-site-theme';

  function readStoredTheme() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null; // file:// or blocked storage
    }
  }

  function storeTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      /* non-fatal */
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      var next = theme === 'light' ? 'dark' : 'light';
      toggle.textContent = theme === 'light' ? '☾' : '☀';
      toggle.setAttribute('aria-label', 'Switch to ' + next + ' theme');
      toggle.setAttribute('title', 'Switch to ' + next + ' theme');
    }
  }

  function initTheme() {
    var stored = readStoredTheme();
    var prefersLight =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(stored || (prefersLight ? 'light' : 'dark'));

    var toggle = document.querySelector('[data-theme-toggle]');
    if (!toggle) return;

    toggle.addEventListener('click', function () {
      var next =
        document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      storeTheme(next);
    });
  }

  function initNav() {
    var toggle = document.querySelector('[data-nav-toggle]');
    var nav = document.getElementById('site-nav');
    if (!toggle || !nav) return;

    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function markCurrentPage() {
    var here = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var links = document.querySelectorAll('#site-nav a[href]');
    for (var i = 0; i < links.length; i += 1) {
      var target = links[i].getAttribute('href').split('#')[0].toLowerCase();
      if (target && target === here) {
        links[i].setAttribute('aria-current', 'page');
      }
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // file:// and plain http fallback
    return new Promise(function (resolve, reject) {
      var scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', 'readonly');
      scratch.style.position = 'fixed';
      scratch.style.top = '-1000px';
      document.body.appendChild(scratch);
      scratch.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (error) {
        ok = false;
      }
      document.body.removeChild(scratch);
      if (ok) resolve();
      else reject(new Error('copy unavailable'));
    });
  }

  function initCopyButtons() {
    var blocks = document.querySelectorAll('.code');
    for (var i = 0; i < blocks.length; i += 1) {
      (function (block) {
        var pre = block.querySelector('pre');
        var button = block.querySelector('.copy-button');
        if (!pre || !button) return;

        button.addEventListener('click', function () {
          copyText(pre.innerText.replace(/\s+$/, '')).then(
            function () {
              flash(button, 'copied', 'done');
            },
            function () {
              flash(button, 'select manually', 'fail');
            }
          );
        });
      })(blocks[i]);
    }
  }

  function flash(button, label, state) {
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.textContent = label;
    button.setAttribute('data-state', state);
    window.setTimeout(function () {
      button.textContent = original;
      button.removeAttribute('data-state');
    }, 1600);
  }

  function initReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    var reduced =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof window.IntersectionObserver !== 'function') {
      for (var i = 0; i < items.length; i += 1) {
        items[i].classList.add('is-visible');
      }
      return;
    }

    var observer = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );

    for (var j = 0; j < items.length; j += 1) {
      observer.observe(items[j]);
    }
  }

  function initTocHighlight() {
    var links = document.querySelectorAll('.toc a[href^="#"]');
    if (!links.length || typeof window.IntersectionObserver !== 'function') return;

    var byId = {};
    var sections = [];
    for (var i = 0; i < links.length; i += 1) {
      var id = links[i].getAttribute('href').slice(1);
      var section = document.getElementById(id);
      if (section) {
        byId[id] = links[i];
        sections.push(section);
      }
    }

    var observer = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          for (var key in byId) {
            if (Object.prototype.hasOwnProperty.call(byId, key)) {
              byId[key].classList.remove('is-active');
            }
          }
          var active = byId[entry.target.id];
          if (active) active.classList.add('is-active');
        });
      },
      { rootMargin: '-80px 0px -65% 0px', threshold: 0 }
    );

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  function start() {
    initTheme();
    initNav();
    markCurrentPage();
    initCopyButtons();
    initReveal();
    initTocHighlight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
