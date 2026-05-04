// ── Loading state ────────────────────────────
const urlForm = document.querySelector('.url-form');
const loadingOverlay = document.getElementById('loading-overlay');

if (urlForm && loadingOverlay) {
  urlForm.addEventListener('submit', () => {
    loadingOverlay.classList.add('is-active');
    loadingOverlay.removeAttribute('aria-hidden');
  });
}

// Reset when navigating back (bfcache)
window.addEventListener('pageshow', (event) => {
  if (loadingOverlay) {
    loadingOverlay.classList.remove('is-active');
    loadingOverlay.setAttribute('aria-hidden', 'true');
  }
});

// ── Lightbox ─────────────────────────────────
(function () {
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', 'Image preview');
  lightbox.innerHTML = `
    <button class="lightbox-close" aria-label="Close preview">✕</button>
    <img class="lightbox-img" src="" alt="Image preview">
  `;
  document.body.appendChild(lightbox);

  const lightboxImg = lightbox.querySelector('.lightbox-img');

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => { lightboxImg.src = ''; }, 250);
  }

  lightbox.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('is-open')) closeLightbox();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.zoom-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(btn.dataset.zoomSrc);
  });
}());

// ── Filter & selection ───────────────────────
const activeChip = document.querySelector('.filter-chip.is-active');
let activeFilter = activeChip ? (activeChip.dataset.filter || 'all') : 'all';

document.addEventListener('DOMContentLoaded', () => {
  applyFilter();
  updateSelectedCount();
});

document.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-filter]');
  const clear = event.target.closest('[data-clear]');

  if (filter) {
    activeFilter = filter.dataset.filter || 'all';
    applyFilter();
    return;
  }

  if (clear) {
    document.querySelectorAll('input[name="images"]').forEach((input) => {
      input.checked = false;
    });
    updateSelectedCount();
    if (activeFilter === 'checked') {
      applyFilter();
    }
  }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('input[name="images"]')) {
    return;
  }
  updateSelectedCount();
  if (activeFilter === 'checked') {
    applyFilter();
  }
});

function applyFilter() {
  let visibleCount = 0;

  document.querySelectorAll('.image-card').forEach((card) => {
    const checkbox = card.querySelector('input[name="images"]');
    const visible =
      activeFilter === 'all' ||
      (activeFilter === 'target' && card.dataset.targetGalleryJpg === 'true') ||
      (activeFilter === 'serial' && card.dataset.serialJpg === 'true') ||
      (activeFilter === 'checked' && checkbox?.checked);

    card.classList.toggle('is-hidden', !visible);
    if (visible) visibleCount += 1;
  });

  document.querySelectorAll('[data-filter]').forEach((btn) => {
    const active = btn.dataset.filter === activeFilter;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  const empty = document.querySelector('[data-filter-empty]');
  if (empty) {
    empty.classList.toggle('is-hidden', visibleCount !== 0);
  }
}

function updateSelectedCount() {
  const total = document.querySelectorAll('input[name="images"]:checked').length;

  document.querySelectorAll('[data-selected-count]').forEach((el) => {
    el.textContent = String(total);
  });

  document.querySelectorAll('.chip-selected-count').forEach((el) => {
    el.textContent = String(total);
  });

  const stickyBar = document.querySelector('.sticky-bar');
  if (stickyBar) {
    stickyBar.classList.toggle('is-visible', total > 0);
  }
}
