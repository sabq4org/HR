// Light / dark / follow-the-device preference (decision 018). Saved in this browser only, never
// sent to the server. index.html applies the saved choice before the first paint; this module keeps
// <html data-theme> in step afterwards and when the device switches while "system" is chosen.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_STORAGE_KEY = 'sabq-theme';
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* storage blocked: follow the device */
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && !!media()?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0f1c2b' : '#1264a3');
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  useEffect(() => {
    applyTheme(choice);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      /* the choice still applies for this visit */
    }
    if (choice !== 'system') return;
    const query = media();
    const follow = () => applyTheme('system');
    query?.addEventListener('change', follow);
    return () => query?.removeEventListener('change', follow);
  }, [choice]);
  return [choice, setChoice] as const;
}
