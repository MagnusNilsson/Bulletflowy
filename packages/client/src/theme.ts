const THEME_KEY = 'bulletflowy-theme';

function isDark(): boolean {
  return document.documentElement.classList.contains('dark') ||
    (!document.documentElement.classList.contains('light') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function apply(dark: boolean) {
  const btn = document.getElementById('dark-mode-btn');
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
    localStorage.setItem(THEME_KEY, 'dark');
    if (btn) btn.textContent = 'Light';
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem(THEME_KEY, 'light');
    if (btn) btn.textContent = 'Dark';
  }
}

export function setDark() { apply(true); }
export function setLight() { apply(false); }
export function toggleTheme() { apply(!isDark()); }

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark') {
    apply(true);
  } else if (saved === 'light') {
    apply(false);
  } else {
    const btn = document.getElementById('dark-mode-btn');
    if (btn) btn.textContent = isDark() ? 'Light' : 'Dark';
  }

  document.getElementById('dark-mode-btn')?.addEventListener('click', toggleTheme);
}
