// Cart + favorites state (localStorage) and cart drawer rendering.
(function () {
  'use strict';

  var CATALOG = null;
  function catalog() {
    if (CATALOG) return CATALOG;
    CATALOG = {};
    // harvested from any product cards present on the page
    document.querySelectorAll('.product-card[data-slug]').forEach(function (el) {
      var slug = el.getAttribute('data-slug');
      var name = el.querySelector('.card-name');
      var price = el.querySelector('.card-price');
      var img = el.querySelector('img');
      // data-price is the machine-readable source: formatted text like
      // "18 900 ₽" would stop parseInt at the thousands space
      var num = parseInt(el.getAttribute('data-price'), 10);
      if (isNaN(num)) num = price ? parseInt(price.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
      if (!CATALOG[slug]) CATALOG[slug] = {
        slug: slug,
        name: name ? name.textContent : slug,
        price: num,
        img: img ? img.getAttribute('src') : ''
      };
    });
    return CATALOG;
  }

  function read(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  var Cart = {
    items: read('aurum.cart'),
    add: function (slug, size, qty, meta) {
      var found = this.items.filter(function (i) { return i.slug === slug && i.size === size; })[0];
      if (found) found.qty += qty;
      else this.items.push({ slug: slug, size: size, qty: qty, name: meta.name, price: meta.price, img: meta.img });
      this.commit();
    },
    setQty: function (idx, qty) {
      if (qty <= 0) this.items.splice(idx, 1);
      else this.items[idx].qty = qty;
      this.commit();
    },
    remove: function (idx) { this.items.splice(idx, 1); this.commit(); },
    count: function () { return this.items.reduce(function (a, i) { return a + i.qty; }, 0); },
    subtotal: function () { return this.items.reduce(function (a, i) { return a + i.qty * i.price; }, 0); },
    commit: function () { save('aurum.cart', this.items); renderCart(); }
  };

  var Favs = {
    list: read('aurum.favs'),
    has: function (slug) { return this.list.indexOf(slug) !== -1; },
    toggle: function (slug) {
      var i = this.list.indexOf(slug);
      if (i === -1) this.list.push(slug); else this.list.splice(i, 1);
      save('aurum.favs', this.list);
      syncFavButtons();
      renderFavoritesPage();
    }
  };

  function fmtPrice(v) {
    return v.toLocaleString('ru-RU').replace(/\u00a0/g, ' ') + ' ₽';
  }

  function renderCart() {
    var wrap = document.querySelector('[data-cart-items]');
    if (!wrap) return;
    var empty = document.querySelector('[data-cart-empty]');
    var subtotal = document.querySelector('[data-cart-subtotal]');
    var checkout = document.querySelector('[data-cart-checkout]');
    wrap.innerHTML = Cart.items.map(function (i, idx) {
      return '<div class="cart-item" data-idx="' + idx + '">' +
        '<div class="cart-item-thumb"><img src="' + i.img + '" alt=""></div>' +
        '<div class="cart-item-mid"><p class="cart-item-name">' + i.name + '</p>' +
        (i.size ? '<p class="cart-item-size">' + i.size + '</p>' : '') +
        '<div class="cart-item-qty">' +
        '<button data-cart-minus aria-label="Decrease">&minus;</button>' +
        '<span>' + i.qty + '</span>' +
        '<button data-cart-plus aria-label="Increase">+</button></div></div>' +
        '<p class="cart-item-price">' + fmtPrice(i.price * i.qty) + '</p>' +
        '<button class="cart-item-remove" data-cart-remove aria-label="Remove">&times;</button></div>';
    }).join('');
    if (empty) empty.hidden = Cart.items.length > 0;
    if (subtotal) subtotal.textContent = fmtPrice(Cart.subtotal());
    if (checkout) checkout.disabled = Cart.items.length === 0;
    document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = Cart.count(); });
  }

  function syncFavButtons() {
    document.querySelectorAll('[data-fav]').forEach(function (btn) {
      btn.classList.toggle('active', Favs.has(btn.getAttribute('data-fav')));
    });
  }

  function renderFavoritesPage() {
    var grid = document.querySelector('[data-fav-grid]');
    if (!grid) return;
    var tpl = document.querySelector('[data-fav-templates]');
    var emptyMsg = document.querySelector('[data-fav-empty]');
    grid.innerHTML = '';
    Favs.list.forEach(function (slug) {
      var card = tpl.content.querySelector('.product-card[data-slug="' + slug + '"]');
      if (card) grid.appendChild(card.cloneNode(true));
    });
    if (emptyMsg) emptyMsg.hidden = Favs.list.length > 0;
    syncFavButtons();
  }

  document.addEventListener('click', function (e) {
    var fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); e.stopPropagation(); Favs.toggle(fav.getAttribute('data-fav')); return; }
    var row = e.target.closest('.cart-item');
    if (row) {
      var idx = parseInt(row.getAttribute('data-idx'), 10);
      if (e.target.closest('[data-cart-minus]')) Cart.setQty(idx, Cart.items[idx].qty - 1);
      else if (e.target.closest('[data-cart-plus]')) Cart.setQty(idx, Cart.items[idx].qty + 1);
      else if (e.target.closest('[data-cart-remove]')) Cart.remove(idx);
    }
  });

  window.AurumStore = { Cart: Cart, Favs: Favs, catalog: catalog, renderCart: renderCart };
  renderCart();
  syncFavButtons();
  renderFavoritesPage();
})();
