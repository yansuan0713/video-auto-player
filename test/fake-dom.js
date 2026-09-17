/**
 * test/fake-dom.js —— 测试用的极简 DOM（开发自测，不属于插件运行时）
 *
 * 只实现插件真正用到的那部分 API：querySelectorAll 支持候选选择器里出现的形态、
 * 元素支持 classList / style / dataset / 事件派发 / textContent 递归读取。
 */
'use strict';

/** 只实现插件真正用到的那几种选择器形态，因此不依赖 jsdom */
function matchCompound(el, compound) {
  const attrRe = /\[([a-zA-Z-]+)(?:([*^$]?=)"?([^\]"]*)"?)?\]/g;
  let rest = compound;
  const attrs = [];
  rest = rest.replace(attrRe, (m, name, op, value) => {
    attrs.push({ name, op, value });
    return '';
  });

  let tag = null;
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tag.length);
  }
  if (tag && el.tagName.toLowerCase() !== tag) return false;

  for (const { name, op, value } of attrs) {
    const actual = el.getAttribute(name);
    if (actual == null) return false;
    if (!op) continue;
    const a = String(actual).toLowerCase();
    const v = String(value).toLowerCase();
    if (op === '=' && a !== v) return false;
    if (op === '*=' && !a.includes(v)) return false;
  }

  const classNames = (rest.match(/\.[a-zA-Z0-9_-]+/g) || []).map((c) => c.slice(1).toLowerCase());
  const idMatch = rest.match(/#([a-zA-Z0-9_-]+)/);
  const hasMatch = rest.match(/:has\(([^)]+)\)/);

  if (idMatch && String(el.id).toLowerCase() !== idMatch[1].toLowerCase()) return false;
  if (classNames.length) {
    const own = String(el.className || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!classNames.every((c) => own.includes(c))) return false;
  }
  if (hasMatch && !el.querySelector(hasMatch[1])) return false;
  return true;
}

function matches(el, selector) {
  return selector.split(',').some((part) => {
    let s = part.trim();
    if (!s) return false;
    if (s.includes(' i]')) s = s.replace(/ i\]/g, ']'); // [attr*="x" i] → [attr*="x"]
    return matchCompound(el, s);
  });
}

class FakeClassList {
  constructor(el) { this.el = el; }
  _list() { return String(this.el.className || '').split(/\s+/).filter(Boolean); }
  contains(name) { return this._list().includes(name); }
  add(...names) { this.el.className = [...new Set([...this._list(), ...names])].join(' '); }
  remove(...names) { this.el.className = this._list().filter((c) => !names.includes(c)).join(' '); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, { type, bubbles: true, cancelable: true }, init); }
  preventDefault() {}
  stopPropagation() {}
}

class FakeElement {
  constructor(tagName, opts = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.ownerDocument = null;
    this.id = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._text = '';
    this.isConnected = true;
    this.shadowRoot = null;
    if (opts.id) this.id = opts.id;
    if (opts.class) this.className = opts.class;
    if (opts.text) this._text = opts.text;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) this.attributes[k] = String(v);
    if (opts.style) this.style = opts.style;
    if (opts.parent) opts.parent.append(this);
  }

  attachShadow(opts = { mode: 'open' }) {
    const root = new FakeElement('#shadow-root');
    root.host = this;
    root.mode = opts.mode;
    if (opts.mode === 'open') {
      this.shadowRoot = root;
    }
    return root;
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) { this.children = []; this._text = String(value); }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) { return this.getAttribute(name) != null; }
  append(child) { return this.appendChild(child); }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  walk(visit) {
    visit(this);
    for (const child of this.children) child.walk(visit);
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) child.walk((node) => { if (matches(node, selector)) found.push(node); });
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) {
    let found = false;
    this.walk((n) => { if (n === node) found = true; });
    return found;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  getBoundingClientRect() {
    const hidden = this.style.display === 'none' || this.style.visibility === 'hidden';
    return { left: 0, top: 0, width: hidden ? 0 : 120, height: hidden ? 0 : 24, right: 120, bottom: 24 };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatchEvent(event) {
    event.target = this;
    if (event.type === 'ratechange') this.rateChangeCount += 1;
    (this.listeners.get(event.type) || []).forEach((fn) => fn(event));
    return true;
  }
  click() { this.dispatchEvent(new FakeEvent('click')); }
}

/** 媒体元素桩：可以手动推进“播放 / 播放结束”，并模拟页面改回倍速 */
class FakeVideoElement extends FakeElement {
  constructor(opts = {}) {
    super('video', opts);
    this.currentTime = 0;
    this.duration = opts.duration === undefined ? 600 : opts.duration;
    this.paused = true;
    this.ended = false;
    this.loop = opts.loop === true;
    this.currentSrc = opts.src || 'https://example.com/media/lesson1.mp4';
    this.src = this.currentSrc;
    this.playCalls = 0;
    this.playRejected = opts.playRejected === true;
    /** 前 N 次 play() 被浏览器拒绝，用来模拟自动播放拦截 */
    this.failPlayTimes = opts.failPlayTimes || 0;
    this.playRejections = 0;
    this._playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.rateChangeCount = 0;
  }

  get playbackRate() { return this._playbackRate; }
  set playbackRate(value) {
    const next = Number(value);
    if (next === this._playbackRate) return; // 真实浏览器：值没变不会触发 ratechange
    this._playbackRate = next;
    this.dispatchEvent(new FakeEvent('ratechange'));
  }

  /** 模拟“网站自己把倍速改回 1.0” */
  resetRateBySite(value = 1) { this.playbackRate = value; }

  play() {
    this.playCalls += 1;
    if (this.failPlayTimes > 0) {
      this.failPlayTimes -= 1;
      this.playRejections += 1;
      // 模拟浏览器拦截：保持暂停，返回被拒绝的 Promise
      return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    }
    this.paused = false;
    if (this.playRejected) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    return Promise.resolve();
  }
  pause() { this.paused = true; }

  /** 模拟“真的连续看了 seconds 秒”（按 1.5s 步进，接近真实 timeupdate 的频率） */
  watch(seconds) {
    this.paused = false;
    this.dispatchEvent(new FakeEvent('loadedmetadata'));
    this.dispatchEvent(new FakeEvent('play'));
    this.dispatchEvent(new FakeEvent('playing'));
    const step = 1.5;
    for (let t = 0; t < seconds; t += step) {
      this.currentTime = Math.min(this.currentTime + step, this.duration - 1);
      this.dispatchEvent(new FakeEvent('timeupdate'));
    }
  }

  /** 模拟自然播放到结尾 */
  finish() {
    this.currentTime = this.duration;
    this.dispatchEvent(new FakeEvent('timeupdate'));
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new FakeEvent('ended'));
  }
}

module.exports = { FakeElement, FakeVideoElement, FakeEvent, matches, matchCompound };
