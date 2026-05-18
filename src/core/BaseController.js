export class BaseController {
  getEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found — try a hard refresh (Ctrl+Shift+R)`);
    return el;
  }

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), delay);
    };
  }
}
