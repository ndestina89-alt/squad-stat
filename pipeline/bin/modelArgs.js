// Argument parsing for the model and backtest CLIs. Pure.
const iso = (v, name) => {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(String(v ?? '')) || Number.isNaN(Date.parse(v))) throw new RangeError(`--${name} must be YYYY-MM-DD or an ISO UTC timestamp`);
  return v.length === 10 ? `${v}T00:00:00Z` : v;
};
const flags = (argv, spec) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || !(a.slice(2) in spec)) throw new RangeError(`unknown option: ${a}`);
    const k = a.slice(2);
    if (spec[k] === 'bool') { out[k] = true; continue; }
    if (i + 1 >= argv.length) throw new RangeError(`${a} needs a value`);
    out[k] = argv[++i];
  }
  return out;
};
const list = (s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

export function parseModelArgs(argv) {
  const f = flags(argv, { competitions: 'val', 'half-life': 'val', ridge: 'val' });
  const out = { competitions: f.competitions ? list(f.competitions) : null, halfLifeDays: null, ridge: null };
  if (f.competitions && out.competitions.length === 0) throw new RangeError('--competitions is empty');
  if (f['half-life'] != null) { out.halfLifeDays = Number(f['half-life']); if (!(out.halfLifeDays > 0)) throw new RangeError('--half-life must be > 0'); }
  if (f.ridge != null) { out.ridge = Number(f.ridge); if (!(out.ridge >= 0)) throw new RangeError('--ridge must be >= 0'); }
  return out;
}

export function parseBacktestArgs(argv) {
  const f = flags(argv, { competition: 'val', 'tune-from': 'val', 'tune-to': 'val', 'holdout-from': 'val', 'holdout-to': 'val', 'step-days': 'val' });
  for (const k of ['competition', 'tune-from', 'tune-to', 'holdout-from', 'holdout-to']) if (!f[k]) throw new RangeError(`--${k} is required (windows are never guessed)`);
  if (!/^[A-Z0-9]{2,5}$/.test(f.competition.toUpperCase())) throw new RangeError('--competition is invalid');
  const out = {
    competition: f.competition.toUpperCase(),
    tune: { from: iso(f['tune-from'], 'tune-from'), to: iso(f['tune-to'], 'tune-to') },
    holdout: { from: iso(f['holdout-from'], 'holdout-from'), to: iso(f['holdout-to'], 'holdout-to') },
    stepDays: f['step-days'] == null ? 7 : Number(f['step-days']),
  };
  if (!(out.stepDays >= 1 && out.stepDays <= 31)) throw new RangeError('--step-days must be between 1 and 31');
  if (!(Date.parse(out.tune.from) < Date.parse(out.tune.to))) throw new RangeError('tune window must have from < to');
  if (!(Date.parse(out.holdout.from) < Date.parse(out.holdout.to))) throw new RangeError('holdout window must have from < to');
  if (Date.parse(out.tune.to) > Date.parse(out.holdout.from)) throw new RangeError('tune window must end before the holdout window starts');
  return out;
}
