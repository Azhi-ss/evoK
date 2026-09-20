/**
 * Deliberately incomplete baseline for examples/demo-suite.
 * Independent suite-metric measures pass_rate by running suite/cases.json
 * against these exports. Do not write a score file.
 *
 * double + isEven match the trusted cases; sum / max / clamp do not.
 * That is 2/5 = 0.4 measured pass_rate — not a hand-written seed score.
 */
function double(n) {
  return n * 2;
}

function isEven(n) {
  return n % 2 === 0;
}

function sum(a, _b) {
  return a;
}

function max(a, _b) {
  return a;
}

function clamp(n, _lo, _hi) {
  return n;
}

module.exports = { double, isEven, sum, max, clamp };
