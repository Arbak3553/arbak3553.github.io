// Scroll-linked effects and appear animations, tuned to the reference motion:
// - hero image scales .8917 -> 1.1 across the first 420px of scroll
// - hero wordmark shrinks (scale 1 -> .4) and rises between 420 and 800px
// - paragraphs reveal word by word, scrubbed by scroll progress
// - generic appear: fade + 40px rise on enter, staggered inside groups
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // hero zoom + wordmark docking are CSS scroll-driven where supported
  // (compositor thread, no main-thread dependence) — this JS path is the
  // fallback. The condition MUST mirror the @supports gate in pages.css.
  var cssScrollHero = typeof CSS !== 'undefined' && CSS.supports &&
    CSS.supports('animation-timeline: scroll()') &&
    CSS.supports('animation-range: 0px 420px');

  // page-load appear (nav / hero) is CSS-driven via body.loaded
  requestAnimationFrame(function () { document.body.classList.add('loaded'); });

  // ---- word-splitting for reveal paragraphs ----
  document.querySelectorAll('[data-reveal]').forEach(function (el) {
    var words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map(function (w) { return '<span class="w">' + w + '</span>'; }).join(' ');
  });

  var revealEls = [].slice.call(document.querySelectorAll('[data-reveal]'));
  var revealProgress = [];      // прогресс за кадр, чтобы читать и писать раздельно
  var revealLast = [];          // прошлый прогресс: не переписываем, если не двигался
  var heroImage = document.querySelector('[data-hero-image]');
  var heroWordmark = document.querySelector('[data-hero-wordmark]');
  var isMobile = window.matchMedia('(max-width: 809.98px)').matches;

  // wordmark keyframes measured on the reference at 1600px
  // the shrunk wordmark must land INSIDE the bar (65px tall on mobile, 80 on
  // desktop) — at shift 92 its bottom sat at 72px and scrolling text ran into it
  var WM = isMobile
    ? { start: 240, end: 480, shift: 106, scale: 0.5 }
    : { start: 420, end: 800, shift: 112, scale: 0.4 };
  // A brand may override where the wordmark lands, because the numbers above
  // are measured off the Aurum reference and belong to its wordmark's
  // proportion. REL'EF sets --wm-scale / --wm-shift in relef.css; anything
  // that does not set them keeps the reference motion untouched.
  (function () {
    var cs = getComputedStyle(document.body);
    var sc = parseFloat(cs.getPropertyValue('--wm-scale'));
    var sh = parseFloat(cs.getPropertyValue('--wm-shift'));
    if (sc > 0) WM.scale = sc;
    if (sh > 0) WM.shift = sh;
  })();
  var HERO = isMobile
    ? { end: 300, from: 0.9, to: 1.08 }
    : { end: 420, from: 0.8917, to: 1.1 };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // the bar may only go solid once the hero photo is out from under it —
  // that is where the difference blend earns its keep
  var heroFrame = document.querySelector('.hero-image-frame');
  var navEl = document.querySelector('.site-nav');
  var solidFrom = 40;
  function measureSolid() {
    solidFrom = heroFrame ? heroFrame.offsetTop + heroFrame.offsetHeight - 140 : 40;
  }
  measureSolid();
  addEventListener('resize', measureSolid);

  function onScroll() {
    var y = window.scrollY;

    // Фон шапки включается ровно в тот момент, когда последний пиксель фото
    // ушёл ей за спину. Считаем по факту, через rect: фото в это время ещё и
    // отмасштабировано zoom-анимацией, поэтому раскладочная высота врёт.
    if (heroImage) {
      var navH = navEl ? navEl.offsetHeight : 80;
      document.body.classList.toggle('nav-solid',
        heroImage.getBoundingClientRect().bottom <= navH);
    } else {
      document.body.classList.toggle('nav-solid', y > solidFrom);
    }

    if (heroImage && !reduced && !cssScrollHero) {
      var p = clamp01(y / HERO.end);
      heroImage.style.transform = 'scale(' + (HERO.from + (HERO.to - HERO.from) * p) + ')';
    }
    if (heroWordmark && !reduced && !cssScrollHero) {
      var q = clamp01((y - WM.start) / (WM.end - WM.start));
      heroWordmark.style.transform = 'translateX(-50%) translateY(' + (-WM.shift * q) + 'px) scale(' + (1 - (1 - WM.scale) * q) + ')';
    }

    // Scrubbed word reveal. Every read happens before every write: measuring
    // and restyling in the same pass makes the browser re-lay-out per element,
    // which is what made this stutter with several paragraphs on screen.
    var vh = window.innerHeight;
    var i, n;
    for (i = 0; i < revealEls.length; i++) {
      var re = revealEls[i].getBoundingClientRect();
      revealProgress[i] = (re.bottom < 0 || re.top > vh)
        ? null                                   // за экраном — трогать нечего
        : clamp01((vh * 0.85 - re.top) / (vh * 0.6));
    }
    for (i = 0; i < revealEls.length; i++) {
      var progress = revealProgress[i];
      if (progress === null || progress === revealLast[i]) continue;
      revealLast[i] = progress;
      var spans = revealEls[i].children;
      n = spans.length;
      // stagger eats a fixed share of the progress, so progress 1 always lands
      // every word at wp 1 — the old formula needed progress > 1 past ~6 words,
      // which left the tail of long paragraphs permanently blurred
      var STAG = 0.55;
      for (var j = 0; j < n; j++) {
        var wp = clamp01((progress - (j / Math.max(n - 1, 1)) * STAG) / (1 - STAG));
        var s = spans[j].style;
        // blur is the expensive part: quantise it to 0.5px steps and skip the
        // write when the step has not moved, instead of restyling every word
        // on every frame
        var step = wp >= 1 ? 0 : Math.round(6 * (1 - wp) * 2) / 2;
        if (spans[j]._b !== step) {
          spans[j]._b = step;
          s.filter = step ? 'blur(' + step + 'px)' : 'none';
        }
        s.opacity = 0.18 + 0.82 * wp;
        s.transform = wp >= 1 ? 'none' : 'translate3d(0,' + 10 * (1 - wp) + 'px,0)';
      }
    }
  }

  /* Пока страница движется — считаем КАЖДЫЙ кадр, читая scrollY сами.
     Прежняя схема планировала rAF из обработчика scroll, и это давало ровно ту
     ступенчатость, на которую жалуются: кадр рисуется по позиции, снятой в
     предыдущем кадре, то есть картинка всегда отстаёт на один кадр от реального
     скролла. Плюс мобильный Safari во время инерционной прокрутки прореживает
     события scroll — там отставание становится рваным.
     Цикл живёт только во время движения: 12 кадров без изменения позиции — и он
     останавливается, чтобы не жечь батарею на статичной странице. */
  if (!reduced) {
    var running = false, lastY = -1, idle = 0;
    function frame() {
      var y = window.scrollY;
      if (y !== lastY) { lastY = y; idle = 0; } else { idle++; }
      onScroll();
      if (idle > 12) { running = false; return; }   // страница стоит — отпускаем кадры
      requestAnimationFrame(frame);
    }
    function kick() {
      idle = 0;
      if (!running) { running = true; requestAnimationFrame(frame); }
    }
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick, { passive: true });
    window.addEventListener('touchstart', kick, { passive: true });
    kick();
  }
  onScroll();
  // browsers restore the scroll position AFTER this script runs (and Safari
  // serves back-navigations from bfcache), which left the wordmark full size
  // over already-scrolled content — re-measure once the page has settled
  addEventListener('load', function () { measureSolid(); onScroll(); });
  addEventListener('pageshow', function () { measureSolid(); onScroll(); });
  requestAnimationFrame(onScroll);

  // ---- generic appear on enter ----
  var appearTargets = [];
  document.querySelectorAll('[data-appear-group]').forEach(function (group) {
    var kids = [].slice.call(group.children).filter(function (k) { return k.tagName !== 'SCRIPT'; });
    // groups animate their direct children with a stagger
    kids.forEach(function (k, i) {
      k.classList.add('ap');
      k.dataset.apDelay = Math.min(i * 90, 360);
      appearTargets.push(k);
    });
  });

  if (reduced) {
    appearTargets.forEach(function (t) { t.classList.add('ap-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          var el = en.target;
          setTimeout(function () { el.classList.add('ap-in'); }, +el.dataset.apDelay || 0);
          io.unobserve(el);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    appearTargets.forEach(function (t) { io.observe(t); });
  }
})();
