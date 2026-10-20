(() => {
  let preference = 'system';
  try { preference = localStorage.getItem('moa-theme') || 'system'; } catch { /* Browser storage may be disabled. */ }
  const dark = preference === 'dark' || (preference !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const theme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = dark ? '#101012' : '#f2f2f7';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101012' : '#f2f2f7');
})();
