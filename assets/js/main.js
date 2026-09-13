// Interactive behavior: drawers, accordions, slideshow, product controls,
// live search, newsletter.
(function () {
  'use strict';

  // ---- cart drawer ----
  var drawer = document.querySelector('[data-cart-drawer]');
  var scrim = document.querySelector('[data-cart-scrim]');

  function openCart() {
    if (!drawer) return;
    drawer.hidden = false; scrim.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { drawer.classList.add('open'); scrim.classList.add('open'); });
    });
    document.body.style.overflow = 'hidden';
  }
  function closeCart() {
    if (!drawer) return;
    drawer.classList.remove('open'); scrim.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(function () { drawer.hidden = true; scrim.hidden = true; }, 520);
  }
  document.querySelectorAll('[data-cart-open]').forEach(function (b) { b.addEventListener('click', openCart); });
  document.querySelectorAll('[data-cart-close]').forEach(function (b) { b.addEventListener('click', closeCart); });
  if (scrim) scrim.addEventListener('click', closeCart);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeCart(); closeMenu(); } });

  // ---- mobile menu ----
  var menu = document.querySelector('[data-mobile-menu]');
  function openMenu() {
    if (!menu) return;
    menu.hidden = false;
    requestAnimationFrame(function () { requestAnimationFrame(function () { menu.classList.add('open'); }); });
    document.body.style.overflow = 'hidden';
  }
  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(function () { menu.hidden = true; }, 380);
  }
  document.querySelectorAll('[data-menu-open]').forEach(function (b) { b.addEventListener('click', openMenu); });
  document.querySelectorAll('[data-menu-close]').forEach(function (b) { b.addEventListener('click', closeMenu); });

  // ---- accordions ----
  document.querySelectorAll('[data-accordion]').forEach(function (item) {
    var btn = item.querySelector('[data-accordion-btn]');
    var panel = item.querySelector('[data-accordion-panel]');
    btn.addEventListener('click', function () {
      var open = item.classList.toggle('open');
      panel.style.maxHeight = open ? panel.scrollHeight + 'px' : '0px';
    });
  });

  // ---- bestsellers slideshow: arrows + autoplay drift ----
  var track = document.querySelector('[data-slideshow-track]');
  if (track) {
    var pos = 0, cardW = 395, autoTimer = null;
    var max = function () { return Math.max(0, track.scrollWidth - track.parentElement.clientWidth + 25); };
    function go(delta) {
      pos = Math.min(Math.max(pos + delta, 0), max());
      track.style.transition = 'transform .7s cubic-bezier(.76,.03,.23,1)';
      track.style.transform = 'translateX(' + (-pos) + 'px)';
    }
    document.querySelector('[data-slide-prev]').addEventListener('click', function () { go(-cardW); restart(); });
    document.querySelector('[data-slide-next]').addEventListener('click', function () { go(cardW); restart(); });
    function tick() { pos >= max() ? go(-max()) : go(cardW); }
    function restart() { clearInterval(autoTimer); autoTimer = setInterval(tick, 3500); }
    restart();
    document.addEventListener('visibilitychange', function () {
      document.hidden ? clearInterval(autoTimer) : restart();
    });
  }

  // ---- product controls ----
  var qtyVal = document.querySelector('[data-qty-value]');
  if (qtyVal) {
    var qty = 1;
    document.querySelector('[data-qty-minus]').addEventListener('click', function () {
      qty = Math.max(1, qty - 1); qtyVal.textContent = qty;
    });
    document.querySelector('[data-qty-plus]').addEventListener('click', function () {
      qty += 1; qtyVal.textContent = qty;
    });
    document.querySelectorAll('[data-size]').forEach(function (pill) {
      pill.addEventListener('click', function () {
        document.querySelectorAll('[data-size]').forEach(function (p) { p.classList.remove('active'); });
        pill.classList.add('active');
      });
    });
    var addBtn = document.querySelector('[data-add-to-cart]');
    addBtn.addEventListener('click', function () {
      var slug = addBtn.getAttribute('data-slug');
      var size = (document.querySelector('[data-size].active') || {}).textContent || '';
      var name = document.querySelector('.panel-title-row h1').textContent;
      var price = parseInt(addBtn.getAttribute('data-price'), 10);
      if (isNaN(price)) price = parseInt(document.querySelector('.panel-price').textContent.replace(/[^0-9]/g, ''), 10) || 0;
      var img = document.querySelector('.product-gallery img').getAttribute('src');
      window.AurumStore.Cart.add(slug, size.trim(), qty, { name: name, price: price, img: img });
      openCart();
    });
  }

  // ---- live search ----
  var searchInput = document.querySelector('[data-search-input]');
  if (searchInput) {
    var grid = document.querySelector('[data-search-grid]');
    var emptyMsg = document.querySelector('[data-search-empty]');
    var cards = [].slice.call(grid.querySelectorAll('.product-card'));
    // phones show the full catalog by default, matching the reference
    var phone = window.matchMedia('(max-width: 809.98px)');
    function applyDefault() {
      if (searchInput.value.trim()) return;
      cards.forEach(function (c) {
        c.style.display = (phone.matches || !c.hasAttribute('data-search-extra')) ? '' : 'none';
      });
    }
    applyDefault();
    phone.addEventListener('change', applyDefault);
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var hit = q
          ? c.querySelector('.card-name').textContent.toLowerCase().indexOf(q) !== -1
          : (phone.matches || !c.hasAttribute('data-search-extra'));
        c.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      if (emptyMsg) emptyMsg.hidden = shown > 0;
    });
    searchInput.focus();
  }

  // ---- newsletter ----
  document.querySelectorAll('[data-newsletter]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      form.hidden = true;
      var done = form.parentElement.querySelector('.newsletter-done');
      if (done) done.hidden = false;
    });
  });
})();

// ---- тема сайта: светлая/тёмная, тумблер в шапке ----
// data-theme живёт на <html> (ставится бут-скриптом в <head> до отрисовки,
// чтобы тёмная тема не мигала белым), выбор — в localStorage. Конструктор
// слушает событие relef-theme и переводит 3D-сцену в тон сайту.
(function () {
  var btns = document.querySelectorAll('[data-theme-toggle]');
  if (!btns.length) return;
  function label() {
    var dark = document.documentElement.dataset.theme === 'dark';
    btns.forEach(function (b) { b.textContent = dark ? 'Светлая' : 'Тёмная'; });
  }
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      if (next === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('relefTheme', next); } catch (e) { /* приватный режим */ }
      label();
      window.dispatchEvent(new CustomEvent('relef-theme', { detail: next }));
    });
  });
  label();
})();
