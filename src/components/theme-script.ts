// Light / dark / device theme, applied before first paint (inline in the root layout's <head>,
// allowed by the CSP's script-src 'unsafe-inline'). The choice lives in this browser only.
export const THEME_KEY = 'cbr-theme';

/** Applies the saved choice and follows the device setting while none is saved. */
export const THEME_SCRIPT = `(function(){try{var k='${THEME_KEY}',m=window.matchMedia('(prefers-color-scheme: dark)');var a=function(){var t=localStorage.getItem(k);document.documentElement.classList.toggle('dark',t==='dark'||(t!=='light'&&m.matches));};a();m.addEventListener('change',a);}catch(e){}})();`;
