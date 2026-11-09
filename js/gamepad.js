// Controller navigation for menus (D-pad / left stick to move, A = select, B = back,
// LB / RB = switch tabs). Flight controls live in flight.js (Input).
const FOCUSABLE = 'button:not([disabled]), select, input[type=range], input[type=text], input[type=password]';

const BTN = { A: 0, B: 1, LB: 4, RB: 5, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

function visible(el) {
  if (el.closest('.hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export class PadNav {
  constructor(input) {
    this.input = input;
    this.lastDir = null;
    this.timer = 0;
    this.active = false; // true once the player has used the controller on a menu
    // Switch back to mouse/keyboard mode as soon as those are used.
    const off = () => this.setActive(false);
    window.addEventListener('mousemove', off, { passive: true });
    window.addEventListener('pointerdown', off, { passive: true });
    window.addEventListener('keydown', off);
  }

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    document.body.classList.toggle('gp-active', on);
  }

  /** Which direction is the player pushing? ('up'|'down'|'left'|'right'|null) */
  direction(pad) {
    const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
    if (b(BTN.UP)) return 'up';
    if (b(BTN.DOWN)) return 'down';
    if (b(BTN.LEFT)) return 'left';
    if (b(BTN.RIGHT)) return 'right';
    const x = pad.axes[0] || 0, y = pad.axes[1] || 0;
    if (Math.max(Math.abs(x), Math.abs(y)) < 0.6) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
  }

  candidates(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
  }

  focusDefault(root) {
    const list = this.candidates(root);
    if (!list.length) return null;
    const el = list.find((e) => e.classList.contains('primary')) || list[0];
    el.focus({ preventScroll: true });
    return el;
  }

  move(root, dir) {
    const cur = document.activeElement;
    if (!cur || !root.contains(cur) || !visible(cur)) return this.focusDefault(root);
    const c = cur.getBoundingClientRect();
    const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of this.candidates(root)) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      let main, side;
      if (dir === 'up') { main = -dy; side = Math.abs(dx); }
      else if (dir === 'down') { main = dy; side = Math.abs(dx); }
      else if (dir === 'left') { main = -dx; side = Math.abs(dy); }
      else { main = dx; side = Math.abs(dy); }
      if (main <= 4) continue; // must be in that direction
      const score = main + side * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return best;
  }

  /** Left/right on a dropdown or slider changes its value. Returns true if handled. */
  adjust(el, dir) {
    if (!el) return false;
    if (el.tagName === 'SELECT' && (dir === 'left' || dir === 'right')) {
      const next = el.selectedIndex + (dir === 'right' ? 1 : -1);
      if (next >= 0 && next < el.options.length) {
        el.selectedIndex = next;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    if (el.type === 'range' && (dir === 'left' || dir === 'right')) {
      const step = parseFloat(el.step) || 1;
      el.value = String(parseFloat(el.value) + (dir === 'right' ? step : -step));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  /**
   * Call every frame while a menu is showing.
   * ctx: { root, onBack(), onTab(dir) }
   */
  update(dt, ctx) {
    const input = this.input;
    const pad = input.pad;
    if (!pad || !ctx || !ctx.root) return;

    let used = false;

    // direction with auto-repeat
    const dir = this.direction(pad);
    this.timer -= dt;
    if (dir && (dir !== this.lastDir || this.timer <= 0)) {
      this.timer = dir !== this.lastDir ? 0.35 : 0.12;
      used = true;
      if (!this.active) this.setActive(true);
      const el = document.activeElement;
      if (!(el && ctx.root.contains(el) && this.adjust(el, dir))) this.move(ctx.root, dir);
    }
    this.lastDir = dir;

    if (input.consumePad(BTN.A)) {
      used = true;
      this.setActive(true);
      const el = document.activeElement;
      if (el && ctx.root.contains(el) && visible(el)) el.click();
      else this.focusDefault(ctx.root);
    }
    if (input.consumePad(BTN.B)) {
      used = true;
      this.setActive(true);
      if (ctx.onBack) ctx.onBack();
    }
    if (ctx.onTab) {
      if (input.consumePad(BTN.LB)) { used = true; this.setActive(true); ctx.onTab(-1); }
      if (input.consumePad(BTN.RB)) { used = true; this.setActive(true); ctx.onTab(1); }
    }

    // After a screen change the old focus is gone: grab a sensible one.
    if (this.active && !used) {
      const el = document.activeElement;
      if (!el || !ctx.root.contains(el) || !visible(el)) this.focusDefault(ctx.root);
    }
  }
}
