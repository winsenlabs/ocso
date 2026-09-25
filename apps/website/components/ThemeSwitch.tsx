"use client";

import { useSyncExternalStore } from "react";

export const THEME_KEY = "ocso-theme";
type Theme = "dark" | "light";

/** Runs before first paint (inlined in the layout) so the page never flashes the wrong theme. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch(e){}`;

const THEME_EVENT = "ocso-theme";
const readTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const subscribe = (cb: () => void) => {
  window.addEventListener(THEME_EVENT, cb);
  return () => window.removeEventListener(THEME_EVENT, cb);
};

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new Event(THEME_EVENT));
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private window: lasts for this page */
    }
  };

  const light = theme === "light";
  return (
    <button type="button" role="switch" aria-checked={light} onClick={flip} className="group inline-flex items-center gap-3 text-sm text-fg/70 hover:text-fg">
      <span className="w-20 text-right">{light ? "Light mode" : "Dark mode"}</span>
      <span className="relative h-7 w-12 rounded-full border border-fg/15 bg-fg/10 transition">
        <span className={`absolute top-0.5 grid size-[1.375rem] place-items-center rounded-full bg-fg text-bg shadow transition-all duration-300 ${light ? "left-[1.5rem]" : "left-0.5"}`}>
          {light ? (
            <svg viewBox="0 0 16 16" className="size-3" aria-hidden><circle cx="8" cy="8" r="3" fill="currentColor" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-3" aria-hidden><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" fill="currentColor" /></svg>
          )}
        </span>
      </span>
    </button>
  );
}
