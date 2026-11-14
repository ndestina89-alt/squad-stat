// Limited-memory BFGS with Armijo backtracking. f(x) must return { value, grad }.
// A non-finite value is treated as "outside the feasible region" and makes the line search back off.
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => Math.sqrt(dot(a, a));

export function minimize(f, x0, { maxIter = 300, memory = 8, gtol = 1e-7, ftol = 1e-12 } = {}) {
  let x = Float64Array.from(x0);
  let cur = f(x);
  if (!Number.isFinite(cur.value)) throw new RangeError('objective is not finite at the starting point');
  const S = []; const Y = [];
  let iterations = 0;
  let reason = 'max_iterations';

  for (; iterations < maxIter; iterations++) {
    const gnorm = norm(cur.grad);
    if (gnorm <= gtol) { reason = 'gradient'; break; }

    // Two-loop recursion for d = -H g.
    const q = Float64Array.from(cur.grad);
    const alpha = new Array(S.length);
    for (let i = S.length - 1; i >= 0; i--) {
      alpha[i] = dot(S[i], q) / dot(Y[i], S[i]);
      for (let k = 0; k < q.length; k++) q[k] -= alpha[i] * Y[i][k];
    }
    if (S.length > 0) {
      const gamma = dot(S[S.length - 1], Y[Y.length - 1]) / dot(Y[Y.length - 1], Y[Y.length - 1]);
      for (let k = 0; k < q.length; k++) q[k] *= gamma;
    } else {
      const s0 = 1 / Math.max(gnorm, 1);
      for (let k = 0; k < q.length; k++) q[k] *= s0;
    }
    for (let i = 0; i < S.length; i++) {
      const beta = dot(Y[i], q) / dot(Y[i], S[i]);
      for (let k = 0; k < q.length; k++) q[k] += S[i][k] * (alpha[i] - beta);
    }
    let d = q.map((v) => -v);
    let slope = dot(cur.grad, d);
    if (!(slope < 0)) { // not a descent direction: restart from steepest descent
      S.length = 0; Y.length = 0;
      d = cur.grad.map((v) => -v / Math.max(gnorm, 1));
      slope = dot(cur.grad, d);
    }

    let step = 1;
    let next = null; let xn = null;
    for (let tries = 0; tries < 50; tries++) {
      xn = x.map((v, i) => v + step * d[i]);
      const cand = f(xn);
      if (Number.isFinite(cand.value) && cand.value <= cur.value + 1e-4 * step * slope) { next = cand; break; }
      step *= 0.5;
    }
    if (!next) {
      if (S.length > 0) { S.length = 0; Y.length = 0; continue; } // retry once with fresh curvature
      reason = 'line_search_failed';
      break;
    }

    const s = xn.map((v, i) => v - x[i]);
    const y = next.grad.map((v, i) => v - cur.grad[i]);
    if (dot(s, y) > 1e-12 * norm(s) * norm(y)) {
      S.push(s); Y.push(y);
      if (S.length > memory) { S.shift(); Y.shift(); }
    }
    const decrease = cur.value - next.value;
    x = xn; cur = next;
    if (decrease >= 0 && decrease <= ftol * Math.max(1, Math.abs(cur.value))) { reason = 'function_tolerance'; iterations++; break; }
  }
  const gradNorm = norm(cur.grad);
  return { x, value: cur.value, gradNorm, iterations, converged: reason === 'gradient' || reason === 'function_tolerance', reason };
}
