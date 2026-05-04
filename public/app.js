let activeFilter = 'all';

document.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-filter]');
  const selectAll = event.target.closest('[data-select-all]');
  const clear = event.target.closest('[data-clear]');

  if (filter) {
    activeFilter = filter.dataset.filter || 'all';
    applyFilter();
    return;
  }

  if (!selectAll && !clear) {
    return;
  }

  const checked = Boolean(selectAll);
  getVisibleInputs().forEach((input) => {
    input.checked = checked;
  });

  if (activeFilter === 'checked') {
    applyFilter();
  }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('input[name="images"]') || activeFilter !== 'checked') {
    return;
  }

  applyFilter();
});

function applyFilter() {
  document.querySelectorAll('.image-card').forEach((card) => {
    const checkbox = card.querySelector('input[name="images"]');
    const visible =
      activeFilter === 'all' ||
      (activeFilter === 'serial' && card.dataset.serialJpg === 'true') ||
      (activeFilter === 'checked' && checkbox?.checked);

    card.classList.toggle('is-hidden', !visible);
  });

  document.querySelectorAll('[data-filter]').forEach((button) => {
    const active = button.dataset.filter === activeFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function getVisibleInputs() {
  return [...document.querySelectorAll('.image-card:not(.is-hidden) input[name="images"]')];
}
