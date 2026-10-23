/* Rough API-equivalent prices in USD per million tokens: [input, output]. Cache writes cost 1.25x the
   input price and cache reads 0.1x. Subscriptions are flat-rate, so the result is a scale of use, not a
   bill, and models without a known price return null so they can be left out instead of guessed. */
function price(model) {
  const m = String(model).toLowerCase();
  if (m === 'claude chat') return null;
  if (m.includes('haiku')) return /3-5|3\.5|3-haiku/.test(m) ? [0.8, 4] : [1, 5];
  if (m.includes('sonnet')) return [3, 15];
  if (m.includes('opus')) return /opus-4-1|opus-4-2025|3-opus/.test(m) ? [15, 75] : [5, 25];
  return null;
}

/* a = [input, output, cacheWrite, cacheRead] tokens. */
function value(model, a) {
  const p = price(model);
  if (!p) return null;
  return (a[0] * p[0] + a[1] * p[1] + a[2] * p[0] * 1.25 + a[3] * p[0] * 0.1) / 1e6;
}

module.exports = { price, value };
