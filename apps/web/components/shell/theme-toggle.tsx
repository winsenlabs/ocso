'use client';

const STORAGE_KEY = 'ocso-theme';

/** Light / dark toggle (design/OCSONav): data-theme on <html>, persisted when storage is available. */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode / blocked storage: the toggle still works for this page view.
    }
  }

  return (
    <button type="button" className="icon-btn" title="Toggle dark / light theme" aria-label="Toggle dark / light theme" onClick={toggle}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15.5 11.5A6 6 0 0 1 8.5 4.5 6 6 0 1 0 15.5 11.5z" />
      </svg>
    </button>
  );
}
