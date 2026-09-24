// Fixer Premiere — client script (no dependencies).
(() => {
  'use strict';

  const TOKEN_KEY = 'fp_access_token';
  // Shape of a server-issued token (base64url payload + "." + base64url HMAC).
  const TOKEN_RE = /^[A-Za-z0-9_-]{10,1000}\.[A-Za-z0-9_-]{20,100}$/;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- storage (private mode / blocked storage safe) ----------
  const store = {
    get() {
      try {
        const token = localStorage.getItem(TOKEN_KEY) || '';
        if (token && !TOKEN_RE.test(token)) {
          localStorage.removeItem(TOKEN_KEY);
          return '';
        }
        return token;
      } catch {
        return '';
      }
    },
    set(token) {
      if (!TOKEN_RE.test(token || '')) return;
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
    const outside = $$('main, footer, .skip-link');
    const setOpen = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      // Keep keyboard and screen-reader focus inside the open menu.
      outside.forEach((el) => {
        el.inert = open;
      });
      if (open) $('a', nav)?.focus({ preventScroll: true });
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
      link.dataset.defaultLabel ??= link.textContent;
      link.dataset.defaultHref ??= link.getAttribute('href');
      link.href = '/watch';
      link.textContent = 'Watch now';
    });
    $$('[data-checkout="film"]').forEach((button) => {
      const link = document.createElement('a');
      link.className = button.className;
      link.href = '/watch';
      link.textContent = button.dataset.ownedLabel || 'Continue watching';
      button.replaceWith(link);
    });
    $$('[data-owned-hide]').forEach((el) => {
      el.hidden = true;
    });
    $$('[data-owned-show]').forEach((el) => {
      el.hidden = false;
    });
  }

  function resetWatchCta() {
    $$('[data-watch-cta]').forEach((link) => {
      if (link.dataset.defaultHref) link.href = link.dataset.defaultHref;
      if (link.dataset.defaultLabel) link.textContent = link.dataset.defaultLabel;
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
          source.type = /\.webm(\?|$)/i.test(src) ? 'video/webm' : 'video/mp4';
          video.append(source);
        });
        // The browser tries each <source> in turn; only the last one failing means no trailer.
        video.lastElementChild?.addEventListener('error', () =>
          toast('The trailer could not be loaded. Please try again later.', true),
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
    const changed = root.dataset.currentState !== name;
    root.dataset.currentState = name;
    let active = null;
    $$('[data-state]', root).forEach((el) => {
      const on = el.dataset.state === name;
      el.classList.toggle('is-active', on);
      if (on) active = el;
    });
    // Move focus to the new heading so screen readers announce the change.
    const heading = changed && active && $('h1, h2', active);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
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
        // Works even if this browser blocks storage.
        $('[data-watch-now]', root).href = data.watchUrl;
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
    const fromLink = new URLSearchParams(window.location.search).get('t');
    if (fromLink !== null) history.replaceState(null, '', '/watch');
    // A link is only remembered once the server has confirmed it, so opening a
    // bad link never wipes the access already saved on this device.
    const saved = store.get();
    let token = fromLink !== null ? fromLink : saved;

    const deny = (message) => {
      if (fromLink === null || fromLink === store.get()) {
        store.clear();
        resetWatchCta();
      }
      $('[data-denied-message]', root).textContent = message || 'This watch link is not valid.';
      showState(root, 'denied');
    };
    $$('[data-forget]', root).forEach((button) =>
      button.addEventListener('click', () => {
        store.clear();
        window.location.replace('/watch');
      }),
    );

    if (fromLink !== null && !TOKEN_RE.test(fromLink)) {
      if (!saved) return deny();
      token = saved;
      toast('That link was not valid — using the access saved on this device.');
    }
    if (!token) return showState(root, 'locked');

    const fetchSource = async () => {
      const { ok, status, data } = await api('/api/film', { token });
      if (ok) return data;
      if (status === 401 || status === 403) deny(data.message);
      else {
        $('[data-watch-error]', root).textContent =
          data.message || 'The film could not be loaded. Check your connection and try again.';
        showState(root, 'error');
      }
      return null;
    };

    showState(root, 'loading');
    let data = await fetchSource();
    if (!data && token === fromLink && saved && saved !== fromLink && root.dataset.currentState === 'denied') {
      // The link was rejected but this device already has access: use that.
      token = saved;
      toast('That link was not valid — using the access saved on this device.');
      showState(root, 'loading');
      data = await fetchSource();
    }
    if (!data) return;
    if (fromLink !== null && token === fromLink) {
      store.set(fromLink);
      initAccessAwareness();
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
      let failures = 0;
      video.addEventListener('playing', () => {
        failures = 0;
      });
      // Signed links expire after a few hours: get a fresh one and resume at the same spot.
      video.addEventListener('error', async () => {
        failures += 1;
        if (failures > 3) {
          $('[data-watch-error]', root).textContent = 'The film could not be played right now. Please try again later.';
          return showState(root, 'error');
        }
        const resumeAt = video.currentTime || 0;
        const fresh = await fetchSource();
        if (!fresh || fresh.source.kind !== 'video') return;
        video.addEventListener(
          'loadedmetadata',
          () => {
            if (resumeAt) video.currentTime = resumeAt;
            video.play().catch(() => {});
          },
          { once: true },
        );
        video.src = fresh.source.src;
      });
      video.src = data.source.src;
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
