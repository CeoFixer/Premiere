// Fixer Premiere — client script (no dependencies).
(() => {
  'use strict';

  const TOKEN_KEY = 'fp_access_token';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- storage (private mode / blocked storage safe) ----------
  const store = {
    get() {
      try {
        return localStorage.getItem(TOKEN_KEY) || '';
      } catch {
        return '';
      }
    },
    set(token) {
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* storage unavailable — the e-mailed link still works */
      }
    },
    clear() {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
    },
  };

  // ---------- toast ----------
  let toastTimer;
  function toast(message, isError = false) {
    const el = $('.toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.toggle('is-error', isError);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => {
        el.hidden = true;
      }, 300);
    }, 5000);
  }

  // ---------- API helper ----------
  async function api(path, { method = 'GET', body, token } = {}) {
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    } catch {
      return { ok: false, status: 0, data: { message: 'No connection. Check your internet and try again.' } };
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    return { ok: res.ok, status: res.status, data };
  }

  function setLoading(button, loading) {
    if (!button) return;
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
  }

  // ---------- header & navigation ----------
  function initHeader() {
    const header = $('[data-header]');
    const toggle = $('[data-nav-toggle]');
    const nav = $('[data-nav]');
    if (!header) return;

    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    if (!toggle || !nav) return;
    const setOpen = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    window.matchMedia('(min-width: 961px)').addEventListener('change', (e) => e.matches && setOpen(false));
  }

  // Buyers see "Continue watching" instead of the buy buttons.
  function initAccessAwareness() {
    const token = store.get();
    if (!token) return;
    $$('[data-watch-cta]').forEach((link) => {
      link.href = '/watch';
      link.textContent = 'Watch now';
    });
    $$('[data-checkout="film"]').forEach((button) => {
      const link = document.createElement('a');
      link.className = button.className;
      link.href = '/watch';
      link.innerHTML = button.dataset.ownedLabel || 'Continue watching';
      button.replaceWith(link);
    });
    $$('[data-owned-hide]').forEach((el) => {
      el.hidden = true;
    });
    $$('[data-owned-show]').forEach((el) => {
      el.hidden = false;
    });
  }

  // ---------- reveal on scroll ----------
  function initReveal() {
    const items = $$('.reveal');
    if (!items.length) return;
    if (reducedMotion || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    items.forEach((el) => io.observe(el));
  }

  // ---------- checkout ----------
  async function startCheckout(button, body) {
    setLoading(button, true);
    const { ok, data } = await api('/api/checkout', { method: 'POST', body });
    if (ok && data.url) {
      window.location.assign(data.url);
      // Keep the spinner while the browser leaves; reset if the user comes back.
      window.addEventListener('pageshow', () => setLoading(button, false), { once: true });
      return;
    }
    setLoading(button, false);
    toast(data.message || 'Checkout is unavailable right now. Please try again.', true);
  }

  function initCheckout() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-checkout="film"]');
      if (!button) return;
      event.preventDefault();
      startCheckout(button, { item: 'film' });
    });

    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'cancelled') {
      toast('Checkout cancelled — you were not charged.');
      params.delete('checkout');
      const query = params.toString();
      history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    }
  }

  function initDonate() {
    const form = $('[data-donate-form]');
    if (!form) return;
    const custom = $('[name="custom"]', form);
    const radios = $$('[name="amount"]', form);
    custom?.addEventListener('input', () => {
      if (custom.value) radios.forEach((r) => (r.checked = false));
    });
    radios.forEach((r) =>
      r.addEventListener('change', () => {
        if (custom) custom.value = '';
      }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const status = $('.form-status', form);
      const selected = radios.find((r) => r.checked);
      const dollars = custom?.value ? Number(custom.value) : Number(selected?.value || 0);
      const cents = Math.round(dollars * 100);
      if (!Number.isFinite(cents) || cents < 100 || cents > 100000) {
        status.textContent = 'Please choose an amount between $1 and $1,000.';
        status.className = 'form-status is-error';
        return;
      }
      status.textContent = '';
      startCheckout($('[type="submit"]', form), { item: 'donation', amount: cents });
    });
  }

  // ---------- forms (subscribe, filmmakers, restore access) ----------
  function initForms() {
    $$('form[data-form]').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const kind = form.dataset.form;
        const status = $('.form-status', form);
        const button = $('[type="submit"]', form);
        const data = Object.fromEntries(new FormData(form).entries());
        status.textContent = '';
        status.className = 'form-status';

        if (kind === 'subscribe' && form.querySelector('[name="consent"]') && !data.consent) {
          status.textContent = 'Please tick the box to confirm you want our newsletter.';
          status.classList.add('is-error');
          return;
        }

        setLoading(button, true);
        const endpoint = kind === 'restore' ? '/api/restore' : '/api/contact';
        const payload = kind === 'restore' ? { email: data.email } : { ...data, kind };
        const res = await api(endpoint, { method: 'POST', body: payload });
        setLoading(button, false);

        if (res.ok) {
          const messages = {
            subscribe: "You're on the list. See you at the next premiere!",
            film: 'Thank you! We received your film and will get back to you by e-mail.',
            restore: res.data.message,
          };
          status.textContent = messages[kind] || 'Sent!';
          status.classList.add('is-ok');
          if (kind !== 'restore') form.reset();
        } else {
          status.textContent = res.data.message || 'Something went wrong. Please try again.';
          status.classList.add('is-error');
        }
      });
    });
  }

  // ---------- trailer & lightbox dialogs ----------
  function closeOnBackdrop(dialog) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    $$('[data-dialog-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  }

  function initTrailer() {
    const dialog = $('[data-trailer-dialog]');
    if (!dialog) return;
    const frame = $('[data-trailer-frame]', dialog);
    let sources = [];
    try {
      sources = JSON.parse(dialog.dataset.sources || '[]');
    } catch {
      sources = [];
    }
    closeOnBackdrop(dialog);
    dialog.addEventListener('close', () => {
      frame.innerHTML = '';
    });

    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-trailer-open]');
      if (!opener) return;
      event.preventDefault();
      if (!sources.length) return toast('The trailer is coming soon.');
      if (dialog.dataset.kind === 'embed') {
        const iframe = document.createElement('iframe');
        iframe.src = sources[0];
        iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
        iframe.allowFullscreen = true;
        iframe.title = 'La Plage — trailer';
        frame.replaceChildren(iframe);
      } else {
        const video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.poster = '/media/still-01.jpg';
        sources.forEach((src) => {
          const source = document.createElement('source');
          source.src = src;
          source.type = 'video/mp4';
          video.append(source);
        });
        video.addEventListener(
          'error',
          () => toast('The trailer could not be loaded. Please try again later.', true),
          true,
        );
        frame.replaceChildren(video);
      }
      dialog.showModal();
    });
  }

  function initLightbox() {
    const dialog = $('[data-lightbox-dialog]');
    const shots = $$('[data-lightbox]');
    if (!dialog || !shots.length) return;
    const img = $('[data-lightbox-img]', dialog);
    let group = [];
    let index = 0;

    const show = (i) => {
      index = (i + group.length) % group.length;
      const shot = group[index];
      img.src = shot.dataset.full || $('img', shot).src;
      img.alt = $('img', shot)?.alt || '';
    };
    closeOnBackdrop(dialog);
    $('[data-lightbox-prev]', dialog).addEventListener('click', () => show(index - 1));
    $('[data-lightbox-next]', dialog).addEventListener('click', () => show(index + 1));
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') show(index - 1);
      if (event.key === 'ArrowRight') show(index + 1);
    });
    let startX = null;
    dialog.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
    dialog.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
      startX = null;
    });

    shots.forEach((shot) =>
      shot.addEventListener('click', () => {
        group = $$(`[data-lightbox="${shot.dataset.lightbox}"]`);
        show(group.indexOf(shot));
        dialog.showModal();
      }),
    );
  }

  function initRails() {
    $$('[data-rail]').forEach((rail) => {
      const id = rail.dataset.rail;
      const step = () => rail.clientWidth * 0.8;
      $(`[data-rail-prev="${id}"]`)?.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: 'smooth' }));
      $(`[data-rail-next="${id}"]`)?.addEventListener('click', () => rail.scrollBy({ left: step(), behavior: 'smooth' }));
    });
  }

  // ---------- thank-you page ----------
  function showState(root, name) {
    $$('[data-state]', root).forEach((el) => el.classList.toggle('is-active', el.dataset.state === name));
  }

  async function initThankYou() {
    const root = $('[data-thank-you]');
    if (!root) return;
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    if (!sessionId) return showState(root, 'generic');

    showState(root, 'loading');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { ok, data } = await api(`/api/access?session_id=${encodeURIComponent(sessionId)}`);
      if (!ok) {
        $('[data-error-message]', root).textContent = data.message || 'We could not confirm your payment.';
        return showState(root, 'error');
      }
      if (data.type === 'donation' && data.status === 'paid') {
        const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: (data.currency || 'usd').toUpperCase() }).format(
          (data.amount || 0) / 100,
        );
        $('[data-donation-amount]', root).textContent = amount;
        history.replaceState(null, '', '/thank-you');
        return showState(root, 'donation');
      }
      if (data.type === 'film' && data.status === 'paid') {
        store.set(data.token);
        initAccessAwareness();
        $('[data-watch-link]', root).value = data.watchUrl;
        $('[data-buyer-email]', root).textContent = data.email || 'your e-mail';
        history.replaceState(null, '', '/thank-you');
        return showState(root, 'film');
      }
      if (data.status !== 'pending') {
        $('[data-error-message]', root).textContent = 'This payment is not valid anymore. Please contact support.';
        return showState(root, 'error');
      }
      showState(root, 'pending');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    showState(root, 'pending');
  }

  function initCopy() {
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const input = $(button.dataset.copy);
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      toast('Link copied. Keep it somewhere safe.');
    });
  }

  // ---------- watch page ----------
  async function initWatch() {
    const root = $('[data-watch]');
    if (!root) return;
    const params = new URLSearchParams(window.location.search);
    let token = params.get('t');
    if (token) {
      store.set(token);
      history.replaceState(null, '', '/watch');
    } else {
      token = store.get();
    }
    if (!token) return showState(root, 'locked');

    const load = async (retry) => {
      showState(root, 'loading');
      const { ok, status, data } = await api('/api/film', { token });
      if (!ok) {
        if (status === 401 || status === 403) {
          store.clear();
          $('[data-denied-message]', root).textContent = data.message || 'This watch link is not valid.';
          return showState(root, 'denied');
        }
        $('[data-watch-error]', root).textContent = data.message || 'The film could not be loaded.';
        return showState(root, 'error');
      }
      $$('[data-viewer-email]', root).forEach((el) => (el.textContent = data.email || 'your purchase'));
      const player = $('[data-player]', root);
      if (data.source.kind === 'video') {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.poster = '/media/still-01.jpg';
        video.setAttribute('controlsList', 'nodownload');
        video.addEventListener('contextmenu', (e) => e.preventDefault());
        video.src = data.source.src;
        video.addEventListener('error', () => {
          // Signed links expire after a few hours — fetch a fresh one once.
          if (!retry) load(true);
        });
        player.replaceChildren(video);
      } else if (data.source.kind === 'embed') {
        const iframe = document.createElement('iframe');
        iframe.src = data.source.src;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
        iframe.allowFullscreen = true;
        iframe.title = data.title;
        player.replaceChildren(iframe);
      } else {
        return showState(root, 'soon');
      }
      showState(root, 'ready');
    };
    await load(false);

    $('[data-forget]', root)?.addEventListener('click', () => {
      store.clear();
      toast('This device no longer has access. Use your e-mailed link to come back.');
      showState(root, 'locked');
    });
  }

  function initAccessPage() {
    const root = $('[data-access-page]');
    if (!root) return;
    if (store.get()) $('[data-has-access]', root).hidden = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    initHeader();
    initAccessAwareness();
    initReveal();
    initCheckout();
    initDonate();
    initForms();
    initTrailer();
    initLightbox();
    initRails();
    initCopy();
    initThankYou();
    initWatch();
    initAccessPage();
  });
})();
