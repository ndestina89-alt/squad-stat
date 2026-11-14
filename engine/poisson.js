// Exact Poisson pmf. log k! comes from a cumulative table of Math.log (no Stirling approximation).
const MAX_K = 400;
const LOG_FACT = (() => {
  const t = new Float64Array(MAX_K + 1);
  for (let k = 2; k <= MAX_K; k++) t[k] = t[k - 1] + Math.log(k);
  return t;
})();

export const logFactorial = (k) => {
  if (!Number.isInteger(k) || k < 0 || k > MAX_K) throw new RangeError(`k must be an integer in [0, ${MAX_K}]`);
  return LOG_FACT[k];
};

export function poissonPmf(k, lambda) {
  if (!(lambda >= 0) || !Number.isFinite(lambda)) throw new RangeError('lambda must be finite and >= 0');
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
}

/** pmf for k = 0..n as a Float64Array. */
export function poissonPmfArray(lambda, n) {
  const out = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) out[k] = poissonPmf(k, lambda);
  return out;
}

/** P(X > n), computed as a sum of the upper terms so it stays accurate when tiny. */
export function poissonTail(lambda, n) {
  let s = 0;
  const hi = Math.max(n + 1, Math.ceil(lambda) + 60);
  for (let k = n + 1; k <= Math.min(hi, MAX_K); k++) s += poissonPmf(k, lambda);
  return s;
}
