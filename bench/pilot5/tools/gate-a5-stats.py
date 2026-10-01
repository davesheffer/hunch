#!/usr/bin/env python3
"""PILOT5 Gate A v5 stats, computed per bench/pilot5/GATE-A5-ANALYSIS-PLAN.md.
Read-only on <out>/runs; writes only <out>/gate-a5-stats.json. Python 3 stdlib only.
Usage: python3 gate-a5-stats.py [--out DIR] [--resamples N]
"""
import argparse, glob, hashlib, json, math, os, random, re, statistics, sys
from datetime import datetime

SEED = 'pilot5-gate-a-v5'
ARMS = ('current-hunch', 'no-hunch')
H, N = ARMS
ID_RE = re.compile(r'\b(dec|con|bug|fnd|cmp|pol)_[0-9a-f]{10}\b')
SUITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'suite.json')


def price(p, out, cw=5.0):
    return (p['input'] * 4 + p['cache_creation'] * cw + p['cache_read'] * 0.20 + out * 20) / 1e6


def med(xs):
    return statistics.median(xs) if xs else None


def gmean(xs):
    return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else None


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def parse_transcript(path):
    """main-thread tool timings, fable-mode invocations, delivered ids."""
    uses, longest, longest_name, fable = {}, 0.0, '', 0
    calls = []  # (secs, name, cmd)
    delivered, mcp_ids = set(), set()
    mcp_uses = set()
    if not os.path.exists(path):
        return None
    for line in open(path, encoding='utf8'):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get('type')
        main = not o.get('parent_tool_use_id')
        if t == 'system' and o.get('subtype') == 'hook_response':
            out = o.get('output') or ''
            try:
                j = json.loads(out)
                ctx = (j.get('hookSpecificOutput') or {}).get('additionalContext') or ''
            except Exception:
                ctx = ''
            for m in ID_RE.finditer(ctx):
                delivered.add(m.group(0))
        if t == 'assistant':
            for c in (o.get('message') or {}).get('content') or []:
                if isinstance(c, dict) and c.get('type') == 'tool_use':
                    name = c.get('name', '')
                    if name.startswith('mcp__hunch__'):
                        mcp_uses.add(c['id'])
                    if 'fable-mode' in json.dumps(c.get('input')) or 'fable-mode' in name:
                        fable += 1
                    if main and o.get('timestamp'):
                        uses[c['id']] = (ts(o['timestamp']), name, c.get('input') or {})
        if t == 'user':
            cont = (o.get('message') or {}).get('content')
            if not isinstance(cont, list):
                continue
            for c in cont:
                if not (isinstance(c, dict) and c.get('type') == 'tool_result'):
                    continue
                if c.get('tool_use_id') in mcp_uses:
                    for m in ID_RE.finditer(json.dumps(c.get('content'))):
                        delivered.add(m.group(0))
                u = uses.get(c.get('tool_use_id'))
                if u and main and o.get('timestamp'):
                    s = ts(o['timestamp']) - u[0]
                    if s >= 0:
                        calls.append((s, u[1], (u[2].get('command') or '') if isinstance(u[2], dict) else ''))
    longest = max((c[0] for c in calls), default=0.0)
    full = [c for c in calls if c[1] in ('Bash', 'PowerShell') and c[0] >= 590
            and re.search(r'npm (run )?test|run-tests|tsx --test', c[2])]
    anyshell590 = [c for c in calls if c[1] in ('Bash', 'PowerShell') and c[0] >= 590]
    return dict(longest_s=longest, n_full=len(full), full_verify=sum(1 for c in full if 'task verify' in c[2]),
                n_shell590=len(anyshell590),
                shell590_verify=sum(1 for c in anyshell590 if 'task verify' in c[2]),
                fable=fable, delivered=sorted(delivered))


def load(out):
    suite = json.load(open(SUITE))
    elig = {t['id']: t['memory']['eligible_record_ids'] for t in suite['tasks']}
    rows = []
    for rj in sorted(glob.glob(os.path.join(out, 'runs', '*', '*', 'run.json'))):
        j = json.load(open(rj))
        d = os.path.dirname(rj)
        c = j.get('cost') or {}
        p = c.get('input_token_parts')
        tr = parse_transcript(os.path.join(d, 'transcript.jsonl'))
        r = dict(task=j['task_id'], rep=j['run_index'], arm=j['arm'], status=j['status'],
                 outcome=(j.get('quality') or {}).get('outcome'), cost=c, parts=p, tr=tr,
                 sel=[i for i in j.get('selected_memory_ids') or [] if not i.startswith('htask_')],
                 hdel=[i for i in j.get('delivered_eligible_ids') or [] if not i.startswith('htask_')])
        r['scored'] = j['status'] not in ('isolation_breach', 'invalid_exposure')
        r['counted'] = j['status'] == 'completed'
        r['pass'] = r['outcome'] == 'passed' and r['counted']
        out_t = c.get('output_tokens')
        r['usd'] = price(p, out_t) if (p and out_t is not None) else None
        r['usd1h'] = price(p, out_t, 8.0) if (p and out_t is not None) else None
        r['in'] = c.get('input_tokens')
        r['main_in'] = c.get('main_input_tokens')
        r['calls'] = c.get('main_model_calls')
        r['agent_s'] = c['agent_wall_clock_ms'] / 1000 if c.get('agent_wall_clock_ms') is not None else None
        r['minus_longest'] = (r['agent_s'] - tr['longest_s']) if (tr and r['agent_s'] is not None) else None
        rows.append(r)
    return rows, elig


def cells_for(rows, key, include_to=None):
    """{(task,arm): [values]} over counted runs (+ timed_out lower-bound values via include_to fn)."""
    cells = {}
    for r in rows:
        if r['counted']:
            v = r[key]
        elif include_to and r['status'] == 'timed_out':
            v = include_to(r)
        else:
            continue
        if v is not None:
            cells.setdefault((r['task'], r['arm']), []).append(v)
    return cells


def pooled(cells, tasks):
    ratios = {}
    for t in tasks:
        a, b = cells.get((t, H), []), cells.get((t, N), [])
        if len(a) >= 2 and len(b) >= 2:
            ratios[t] = med(a) / med(b)
    return ratios, (gmean(list(ratios.values())) if ratios else None)


def summarize(cells, tasks, rng, B, exclude=()):
    use = [t for t in tasks if t not in exclude]
    ratios, g = pooled(cells, use)
    meds = {t: {a: med(cells.get((t, a), [])) for a in ARMS} for t in use}
    boots = []
    if g is not None and B:
        for _ in range(B):
            rc = {k: [rng.choice(v) for _ in v] for k, v in cells.items()}
            _, bg = pooled(rc, list(ratios))
            boots.append(bg)
        boots.sort()
        lo, hi = boots[int(0.025 * B)], boots[int(0.975 * B) - 1]
    else:
        lo = hi = None
    return dict(per_task_median=meds, per_task_ratio=ratios, tasks_used=sorted(ratios),
                missing_tasks=[t for t in use if t not in ratios], pooled=g,
                ci95=[lo, hi], ci_includes_1=(lo <= 1 <= hi) if lo is not None else None,
                moves_down=(g is not None and g < 1.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/Users/Shared/bench-out/pilot5-gate-a5')
    ap.add_argument('--resamples', type=int, default=10000)
    a = ap.parse_args()
    rows, elig = load(a.out)
    tasks = sorted({r['task'] for r in rows})
    B = a.resamples
    seed_int = int(hashlib.sha256(SEED.encode()).hexdigest(), 16)
    R = {'seeding': f"random.Random(int(sha256('{SEED}').hexdigest(),16)) = Random({seed_int}); one RNG stream, "
                    f"measures bootstrapped in fixed order, {B} resamples, within-cell resampling of counted runs",
         'n_runs': len(rows)}
    rng = random.Random(seed_int)

    # status + P1
    st, p1 = {}, {}
    for arm in ARMS:
        rs = [r for r in rows if r['arm'] == arm]
        c = {}
        for r in rs:
            c[r['status']] = c.get(r['status'], 0) + 1
        st[arm] = c
        sc = [r for r in rs if r['scored']]
        p1[arm] = dict(passes=sum(r['pass'] for r in sc), scored=len(sc),
                       rate=(sum(r['pass'] for r in sc) / len(sc)) if sc else None)
    R['status_counts'] = st
    R['p1'] = p1
    R['p1_holds'] = p1[H]['rate'] >= p1[N]['rate'] - 0.05 - 1e-12
    R['p1_per_task'] = {t: {arm: f"{sum(r['pass'] for r in rows if r['task']==t and r['arm']==arm and r['scored'])}/"
                                 f"{sum(1 for r in rows if r['task']==t and r['arm']==arm and r['scored'])}" for arm in ARMS}
                        for t in tasks}
    R['non_counted_runs'] = [f"{r['task']}/{r['rep']}-{r['arm']}: {r['status']}"
                             + (f" (input_tokens_lower_bound={r['cost'].get('input_tokens_lower_bound')})" if r['status'] == 'timed_out' else '')
                             for r in rows if r['status'] != 'completed']
    R['cost_null_counted'] = [f"{r['task']}/{r['rep']}-{r['arm']}" for r in rows if r['counted'] and r['usd'] is None]

    # primary
    measures = {'P2_cost_usd': 'usd', 'P3_input_tokens': 'in', 'P4_main_model_calls': 'calls'}
    prim = {}
    for name, key in measures.items():
        prim[name] = summarize(cells_for(rows, key), tasks, rng, B)
    R['primary'] = prim
    nd = sum(prim[m]['moves_down'] for m in prim)
    if len(prim['P2_cost_usd']['tasks_used']) < 4 or len(prim['P3_input_tokens']['tasks_used']) < 4 or len(prim['P4_main_model_calls']['tasks_used']) < 4:
        v = 'INCONCLUSIVE'
    elif R['p1_holds'] and nd == 3:
        v = 'WIN'
    elif R['p1_holds'] and nd >= 1:
        v = 'PARTIAL'
    else:
        v = 'LOSS'
    R['verdict'] = v
    R['n_moving_down'] = nd

    # sensitivity
    sens = {}
    # 1: timed-out lower bound as if complete (tokens known only for P3; P2 needs parts -> use parts if present, else report n/a)
    def lb_in(r):
        return r['cost'].get('input_tokens_lower_bound')
    def lb_usd(r):
        p, o = r['parts'], r['cost'].get('output_tokens_lower_bound')
        if r['cost'].get('output_tokens') is not None:
            o = r['cost']['output_tokens']
        return price(p, o) if (p and o is not None) else None
    sens['1_timed_out_included_P3'] = summarize(cells_for(rows, 'in', lb_in), tasks, rng, B)
    sens['1_timed_out_included_P2'] = summarize(cells_for(rows, 'usd', lb_usd), tasks, rng, B)
    sens['1_note'] = ('P2 includes a timed-out run only if it has input_token_parts and an output token figure '
                      '(or output_tokens_lower_bound); otherwise it cannot be priced and stays left out.')
    sens['2_P2_cache_write_1h'] = summarize(cells_for(rows, 'usd1h'), tasks, rng, B)
    sens['3_P3_main_loop_only'] = summarize(cells_for(rows, 'main_in'), tasks, rng, B)
    sens['4_without_operation-268'] = {name: summarize(cells_for(rows, key), tasks, rng, B, exclude=('operation-268',))
                                       for name, key in measures.items()}
    R['sensitivity'] = sens

    # secondary 1: time
    R['sec1_time'] = {'raw_agent_s': summarize(cells_for(rows, 'agent_s'), tasks, rng, B),
                      'agent_minus_longest_tool_call_s': summarize(cells_for(rows, 'minus_longest'), tasks, rng, B)}
    R['longest_call_median_s'] = {arm: med([r['tr']['longest_s'] for r in rows if r['arm'] == arm and r['counted'] and r['tr']]) for arm in ARMS}

    # secondary 2: full-suite waits (scored runs only)
    s2 = {}
    for arm in ARMS:
        rs = [r for r in rows if r['arm'] == arm and r['scored'] and r['tr']]
        s2[arm] = dict(runs=len(rs),
                       runs_with_ge590_test_call=sum(1 for r in rs if r['tr']['n_full'] > 0),
                       via_task_verify=sum(1 for r in rs if r['tr']['full_verify'] > 0),
                       not_via_task_verify=sum(1 for r in rs if r['tr']['n_full'] > r['tr']['full_verify']),
                       runs_with_any_shell_ge590=sum(1 for r in rs if r['tr']['n_shell590'] > 0),
                       any_shell_ge590_via_task_verify=sum(1 for r in rs if r['tr']['shell590_verify'] > 0))
    R['sec2_full_suite_waits'] = s2
    R['sec2_mechanism_ok'] = s2[H]['runs_with_ge590_test_call'] <= s2[N]['runs_with_ge590_test_call']
    R['sec2_rule'] = 'main-thread Bash/PowerShell call >=590 s whose command matches /npm (run )?test|run-tests|tsx --test/ (as gate-a4-tooltime.mjs); "any_shell" = no command filter'

    # secondary 3: delivery (hunch arm, scored runs). Transcript-based primary; harness-based reported too.
    def deliv(kind):
        per_task, tp, td, te = {}, 0, 0, 0
        tpf = 0
        for r in rows:
            if r['arm'] != H or not r['scored']:
                continue
            E = {i for i in elig[r['task']] if not i.startswith('htask_')}
            Efull = len(elig[r['task']])
            d = {i for i in (r['tr']['delivered'] if kind == 'transcript' else r['hdel']) if not i.startswith('htask_')}
            hit = len(d & E)
            tp += hit; td += len(d); te += len(E); tpf += 0
            per_task.setdefault(r['task'], []).append(dict(
                prec=(hit / len(d)) if d else 0.0, recall=(hit / len(E)) if E else None,
                recall_ps1=(hit / Efull) if Efull else None, delivered=len(d), hit=hit, eligible=len(E)))
        return dict(micro_precision=(tp / td) if td else None, micro_recall=(tp / te) if te else None,
                    sum_delivered=td, sum_hit=tp, sum_eligible=te,
                    per_task_median={t: dict(precision=med([x['prec'] for x in v]), recall=med([x['recall'] for x in v]),
                                             recall_ps1_denominator_incl_htask=med([x['recall_ps1'] for x in v])) for t, v in per_task.items()},
                    median_of_task_medians_precision=med([med([x['prec'] for x in v]) for v in per_task.values()]))
    R['sec3_delivery_transcript_based'] = deliv('transcript')
    R['sec3_delivery_harness_based'] = deliv('harness')
    R['sec3_note'] = ('Primary = transcript-based (ids in hook additionalContext + mcp__hunch__ tool results, htask_ excluded; '
                      'eligibility lists from suite.json with htask_ ids dropped from both sides). Harness-based = run.json delivered_eligible_ids. '
                      'Precision uses delivered ids of any record, recall the eligible list. Mechanism: micro precision >= 0.20.')
    tp_ = R['sec3_delivery_transcript_based']['micro_precision']
    R['sec3_mechanism_ok'] = tp_ is not None and tp_ >= 0.20

    # secondary 4: memory tasks on their own
    s4 = {}
    for t in ('continuation-375', 'repeated-bug-360', 'operation-268'):
        s4[t] = {}
        for name, key in list(measures.items()) + [('time_agent_minus_longest_s', 'minus_longest'), ('raw_agent_s', 'agent_s')]:
            c = cells_for(rows, key)
            s4[t][name] = dict(median_hunch=med(c.get((t, H), [])), median_nohunch=med(c.get((t, N), [])),
                               n_hunch=len(c.get((t, H), [])), n_nohunch=len(c.get((t, N), [])),
                               ratio=(med(c[(t, H)]) / med(c[(t, N)])) if len(c.get((t, H), [])) >= 1 and len(c.get((t, N), [])) >= 1 else None)
        s4[t]['P1'] = R['p1_per_task'][t]
    R['sec4_memory_tasks'] = s4

    # secondary 5: cost split
    s5 = {}
    for arm in ARMS:
        rs = [r for r in rows if r['arm'] == arm and r['counted'] and r['usd'] is not None]
        comp = dict(cache_writes=sum(r['parts']['cache_creation'] * 5 for r in rs) / 1e6,
                    cache_reads=sum(r['parts']['cache_read'] * 0.2 for r in rs) / 1e6,
                    uncached_input=sum(r['parts']['input'] * 4 for r in rs) / 1e6,
                    output=sum(r['cost']['output_tokens'] * 20 for r in rs) / 1e6)
        tot = sum(comp.values())
        s5[arm] = dict(n=len(rs), total_usd=tot, usd=comp, share={k: v / tot for k, v in comp.items()})
    R['sec5_cost_split'] = s5

    # secondary 6: confounds
    R['sec6_confounds'] = {arm: dict(
        fable_mode_invocations=sum(r['tr']['fable'] for r in rows if r['arm'] == arm and r['scored'] and r['tr']),
        background_wakeups_total=sum((r['cost'].get('background_wakeups') or 0) for r in rows if r['arm'] == arm and r['scored']),
        runs_with_wakeups=sum(1 for r in rows if r['arm'] == arm and r['scored'] and (r['cost'].get('background_wakeups') or 0) > 0))
        for arm in ARMS}

    # secondary 7: noise
    sds, ssq, df = {}, 0.0, 0
    for name, key in measures.items():
        c = cells_for(rows, key)
        sd = {}
        ss, d = 0.0, 0
        for (t, arm), v in sorted(c.items()):
            if len(v) >= 2 and all(x > 0 for x in v):
                s = statistics.stdev([math.log(x) for x in v])
                sd[f'{t}|{arm}'] = s
                ss += s * s * (len(v) - 1); d += len(v) - 1
        pooled_sd = math.sqrt(ss / d) if d else None
        need = (2 * (1.96 + 0.84) ** 2 * pooled_sd ** 2 / math.log(1.2) ** 2) if pooled_sd else None
        sds[name] = dict(cell_log_sd=sd, pooled_log_sd=pooled_sd, runs_per_arm_for_20pct=need,
                         runs_per_arm_ceil=math.ceil(need) if need else None)
    R['sec7_noise'] = sds
    R['sec7_formula'] = 'n per arm ~= 2*(1.96+0.84)^2 * SD^2 / ln(1.2)^2, SD = pooled (df-weighted) within-cell log-scale SD over cells with >=2 counted runs; applies to a single-task 20% median difference, not to the pooled ratio'

    # manifest hash
    json.dump(R, open(os.path.join(a.out, 'gate-a5-stats.json'), 'w'), indent=1, default=str)
    print(markdown(R))


def f(x, d=3):
    return 'n/a' if x is None else f'{x:.{d}f}'


def markdown(R):
    L = []
    L.append(f"# Gate A v5 stats\n\nVerdict: **{R['verdict']}** (P1 holds: {R['p1_holds']}; measures moving down: {R['n_moving_down']}/3)\n")
    L.append(f"Seeding: {R['seeding']}\n")
    L.append('## Run status\n')
    for arm, c in R['status_counts'].items():
        L.append(f'- {arm}: {c}')
    L.append('\nNon-completed runs: ' + '; '.join(R['non_counted_runs']))
    if R['cost_null_counted']:
        L.append('Counted runs without priceable parts: ' + ', '.join(R['cost_null_counted']))
    L.append('\n## P1\n')
    for arm, p in R['p1'].items():
        L.append(f"- {arm}: {p['passes']}/{p['scored']} = {f(p['rate'])}")
    L.append(f"- per task: {R['p1_per_task']}\n")
    L.append('## Primary (per-task medians hunch / no-hunch, ratio, pooled, 95% CI)\n')
    def block(name, s):
        L.append(f"### {name}\n")
        L.append('| task | hunch med | no-hunch med | ratio |\n|---|---|---|---|')
        for t, m in s['per_task_median'].items():
            L.append(f"| {t} | {f(m[H],4)} | {f(m[N],4)} | {f(s['per_task_ratio'].get(t))} |")
        L.append(f"\nPooled {f(s['pooled'])}, 95% CI [{f(s['ci95'][0])}, {f(s['ci95'][1])}], includes 1.00: {s['ci_includes_1']}; moves down: {s['moves_down']}; missing tasks: {s['missing_tasks']}\n")
    for name, s in R['primary'].items():
        block(name, s)
    L.append('## Sensitivity\n')
    for k, s in R['sensitivity'].items():
        if k == '1_note':
            L.append(f'Note (row 1): {s}\n'); continue
        if k.startswith('4'):
            for n, ss in s.items():
                L.append(f"- row 4 {n}: pooled {f(ss['pooled'])} CI [{f(ss['ci95'][0])}, {f(ss['ci95'][1])}] tasks {ss['tasks_used']}")
        else:
            L.append(f"- {k}: pooled {f(s['pooled'])} CI [{f(s['ci95'][0])}, {f(s['ci95'][1])}] incl1={s['ci_includes_1']} tasks {s['tasks_used']}")
    L.append('\n## Secondary 1: time\n')
    for k, s in R['sec1_time'].items():
        L.append(f"- {k}: pooled {f(s['pooled'])} CI [{f(s['ci95'][0])}, {f(s['ci95'][1])}]; per-task ratios { {t: round(v,3) for t,v in s['per_task_ratio'].items()} }")
    L.append(f"- median longest main-thread call (s): {R['longest_call_median_s']}")
    L.append('\n## Secondary 2: full-suite waits\n')
    for arm, s in R['sec2_full_suite_waits'].items():
        L.append(f'- {arm}: {s}')
    L.append(f"- mechanism (hunch <= no-hunch): {R['sec2_mechanism_ok']}. Rule: {R['sec2_rule']}")
    L.append('\n## Secondary 3: delivery\n')
    for k in ('sec3_delivery_transcript_based', 'sec3_delivery_harness_based'):
        s = R[k]
        L.append(f"- {k}: micro precision {f(s['micro_precision'])} ({s['sum_hit']}/{s['sum_delivered']}), micro recall {f(s['micro_recall'])} ({s['sum_hit']}/{s['sum_eligible']}); per-task medians {s['per_task_median']}")
    L.append(f"- mechanism (micro precision >= 20%, transcript-based): {R['sec3_mechanism_ok']}\n- {R['sec3_note']}")
    L.append('\n## Secondary 4: memory tasks\n')
    for t, m in R['sec4_memory_tasks'].items():
        L.append(f'### {t}  (P1 {m["P1"]})')
        for k, v in m.items():
            if k != 'P1':
                L.append(f"- {k}: hunch {f(v['median_hunch'],4)} (n={v['n_hunch']}), no-hunch {f(v['median_nohunch'],4)} (n={v['n_nohunch']}), ratio {f(v['ratio'])}")
    L.append('\n## Secondary 5: cost split\n')
    for arm, s in R['sec5_cost_split'].items():
        L.append(f"- {arm} (n={s['n']}, total ${s['total_usd']:.2f}): " + ', '.join(f'{k} {v*100:.1f}%' for k, v in s['share'].items()))
    L.append('\n## Secondary 6: confounds\n')
    for arm, s in R['sec6_confounds'].items():
        L.append(f'- {arm}: {s}')
    L.append('\n## Secondary 7: noise\n')
    for n, s in R['sec7_noise'].items():
        L.append(f"- {n}: pooled log-SD {f(s['pooled_log_sd'])}, runs per arm for 20% difference ~ {f(s['runs_per_arm_for_20pct'],1)} (ceil {s['runs_per_arm_ceil']})")
    L.append(f"- formula: {R['sec7_formula']}")
    return '\n'.join(L)


if __name__ == '__main__':
    main()
