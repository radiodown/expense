import { createContext, useContext, useEffect, useState } from 'react';

const storageKey = 'moa-theme';
const preferences = ['system', 'light', 'dark'];
const ThemeContext = createContext({ preference: 'system', resolvedTheme: 'light', setPreference: () => {} });

export function readThemePreference() {
  try {
    const saved = localStorage.getItem(storageKey);
    return preferences.includes(saved) ? saved : 'system';
  } catch { return 'system'; }
}
function systemIsDark() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.removeProperty('background-color');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101012' : '#f2f2f7');
}
export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(readThemePreference);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolvedTheme = preference === 'system' ? systemDark ? 'dark' : 'light' : preference;

  useEffect(() => { applyTheme(resolvedTheme); }, [resolvedTheme]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const update = event => {
      if (event.key === storageKey || event.key === null) setPreference(readThemePreference());
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  function changePreference(value) {
    if (!preferences.includes(value)) return;
    const dark = systemIsDark();
    setPreference(value);
    setSystemDark(dark);
    applyTheme(value === 'system' ? dark ? 'dark' : 'light' : value);
    try { localStorage.setItem(storageKey, value); } catch { /* Keep the selection for this session. */ }
  }

  return <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference: changePreference }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);

export function ThemeSelector() {
  const { preference, setPreference } = useTheme();
  return <label className="theme-selector"><span className="sr-only">화면 모드</span>
    <select value={preference} onChange={event => setPreference(event.target.value)}>
      <option value="system">시스템 설정</option><option value="light">라이트 모드</option><option value="dark">다크 모드</option>
    </select>
  </label>;
}
