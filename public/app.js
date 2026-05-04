document.addEventListener('click', (event) => {
  const selectAll = event.target.closest('[data-select-all]');
  const clear = event.target.closest('[data-clear]');

  if (!selectAll && !clear) {
    return;
  }

  const checked = Boolean(selectAll);
  document.querySelectorAll('input[name="images"]').forEach((input) => {
    input.checked = checked;
  });
});
