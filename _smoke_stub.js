// === STUB TOP: browser globals ===
function Option(text, value) { this.text = text; this.value = value; }
const document = {
  getElementById: id => ({
    value: 'all', checked: false, textContent: '', innerHTML: '',
    addEventListener: () => {}, appendChild: () => {}, append: () => {},
    classList: { add: () => {}, remove: () => {} }, add: () => {},
    focus: () => {}, getContext: () => ({}),
    setAttribute: () => {}, removeAttribute: () => {},
    animate: () => ({ onfinish: null }),
    dataset: {}, style: {}, onclick: null, oninput: null, onchange: null,
    querySelector: () => null, querySelectorAll: () => [],
    insertAdjacentHTML: () => {}, remove: () => {},
    getBoundingClientRect: () => ({}),
  }),
  querySelectorAll: () => [],
  querySelector: () => ({ checked: true, value: 'career', dataset: {}, addEventListener: () => {} }),
  createElement: () => ({
    setAttribute: () => {}, append: () => {}, appendChild: () => {},
    dataset: {}, style: {}, animate: () => ({ onfinish: null }),
    classList: { add: () => {}, remove: () => {} },
  }),
  createElementNS: () => ({
    setAttribute: () => {}, append: () => {}, appendChild: () => {},
    dataset: {}, style: {}, animate: () => ({ onfinish: null }),
  }),
  createDocumentFragment: () => ({ appendChild: () => {} }),
};
const window = { addEventListener: () => {} };
const performance = { now: () => 0 };
const requestAnimationFrame = () => {};
function Chart() { return { destroy: () => {} }; }
Chart.prototype = { destroy: () => {} };
