# Gate A v4 stats. Fixes vs stats2: isolation_breach runs have no outcome (excluded everywhere);
# runs with cost.token_measurement=unavailable (timeouts) excluded from cost/token medians only.
# Joins tooltime.json (node tooltime.mjs) for longest tool call and full-suite time.
param([string]$Out = 'C:/bench-out/pilot5-gate-a4', [string]$Tool = "$PSScriptRoot/tooltime.json")
# Opus 5.5 $/Mtok: input 4, output 20, cache read 0.20, cache write assumed 5m rate (1.25x input) = 5
$PRICE = @{ in = 4.0; out = 20.0; cr = 0.20; cw = 5.0 }
$suite = Get-Content "$PSScriptRoot/../suite.json" -Raw | ConvertFrom-Json
$elig = @{}; foreach ($t in $suite.tasks) { $elig[$t.id] = @($t.memory.eligible_record_ids) }
$tt = @{}; if (Test-Path $Tool) { foreach ($r in (Get-Content $Tool -Raw | ConvertFrom-Json)) { $tt["$($r.task)|$($r.rep)|$($r.arm)"] = $r } }
$rows = foreach ($rj in Get-ChildItem "$Out/runs" -Recurse -Depth 2 -Filter run.json) {
  $j = Get-Content $rj.FullName -Raw | ConvertFrom-Json
  $c = $j.cost; $p = $c.input_token_parts
  $costOk = $c.token_measurement -ne 'unavailable' -and $null -ne $p
  $usd = if ($costOk) { ($p.input * $PRICE.in + $p.cache_creation * $PRICE.cw + $p.cache_read * $PRICE.cr + $c.output_tokens * $PRICE.out) / 1e6 } else { $null }
  $hk = $c.hook_injections.by_event
  $prepost = 0; foreach ($e in 'PreToolUse', 'PostToolUse') { if ($hk.$e) { $prepost += $hk.$e.chars } }
  $sel = @($j.selected_memory_ids | Where-Object { $_ -notmatch '^htask_' })
  $hit = @($j.delivered_eligible_ids | Where-Object { $_ -notmatch '^htask_' })
  $E = $elig[$j.task_id]
  $scored = $j.status -ne 'isolation_breach'
  $x = $tt["$($j.task_id)|$($j.run_index)|$($j.arm)"]
  $agent = [math]::Round($c.agent_wall_clock_ms / 1000, 0)
  [pscustomobject]@{
    task = $j.task_id; rep = $j.run_index; arm = $j.arm; status = $j.status
    ok = if ($scored) { [int]$j.success } else { $null }
    val_pass = $j.quality.outcome -eq 'passed'
    agent_s = if ($scored) { $agent } else { $null }
    agent_minus_longest = if ($scored -and $x) { $agent - $x.longest_s } else { $null }
    longest_s = if ($x) { $x.longest_s } else { $null }
    full = if ($x) { $x.full_suite_runs } else { $null }; full_verify = if ($x) { $x.full_via_verify } else { $null }
    fable = if ($x) { $x.fable } else { $null }
    usd = if ($scored -and $costOk) { [math]::Round($usd, 3) } else { $null }
    in_k = if ($scored -and $costOk) { [math]::Round($c.input_tokens / 1000, 0) } else { $null }
    out = if ($scored -and $costOk) { $c.output_tokens } else { $null }
    calls = if ($scored) { $c.main_model_calls } else { $null }; invest = if ($scored) { $c.investigation_tool_calls } else { $null }
    hook = if ($scored) { $c.hook_injections.total.chars } else { $null }; prepost = if ($scored) { $prepost } else { $null }
    mem_n = $sel.Count; mem_hit = $hit.Count; elig_n = $E.Count
    prec = if ($j.arm -eq 'no-hunch' -or -not $scored) { $null } elseif ($sel.Count) { [math]::Round($hit.Count / $sel.Count, 2) } else { 0 }
    recall = if ($j.arm -eq 'no-hunch' -or -not $scored) { $null } else { [math]::Round($hit.Count / $E.Count, 2) }
  }
}
$rows = @($rows | Sort-Object task, rep, arm)
'=== per run'
$rows | Format-Table task, rep, arm, status, ok, val_pass, agent_s, agent_minus_longest, longest_s, full, full_verify, fable, usd, in_k, out, calls, invest, hook, prepost, mem_n, mem_hit, prec, recall -AutoSize | Out-String -Width 300
function Med($xs) { $a = @($xs | Where-Object { $null -ne $_ } | Sort-Object); if (-not $a.Count) { return $null }; $m = [math]::Floor($a.Count / 2); if ($a.Count % 2) { $a[$m] } else { ($a[$m - 1] + $a[$m]) / 2 } }
function Sum($xs) { ($xs | Where-Object { $null -ne $_ } | Measure-Object -Sum).Sum }
function Cnt($xs) { @($xs | Where-Object { $null -ne $_ }).Count }
'=== per arm (medians; n_scored excludes isolation_breach; cost n excludes timeouts)'
$rows | Group-Object arm | ForEach-Object {
  $g = $_.Group; $s = @($g | Where-Object { $null -ne $_.ok })
  [pscustomobject]@{
    arm = $_.Name; n_runs = $g.Count; n_scored = $s.Count
    pass = "{0}/{1}" -f (Sum $s.ok), $s.Count
    timeout_but_validator_passed = @($g | Where-Object { $_.status -eq 'timed_out' -and $_.val_pass }).Count
    agent_s = Med $g.agent_s; agent_minus_longest = Med $g.agent_minus_longest
    usd = Med $g.usd; usd_n = Cnt $g.usd; in_k = Med $g.in_k; out = Med $g.out
    calls = Med $g.calls; invest = Med $g.invest; hook = Med $g.hook; prepost = Med $g.prepost
    prec = Med $g.prec; recall = Med $g.recall
    full_suite_runs = "{0} runs had >=1 (via task verify: {1})" -f @($g | Where-Object { $_.full -gt 0 }).Count, @($g | Where-Object { $_.full_verify -gt 0 }).Count
    fable_invoked = "{0}/{1}" -f @($g | Where-Object { $_.fable -gt 0 }).Count, (Cnt $g.fable)
  }
} | Format-List | Out-String -Width 250
'=== per task x arm (medians)'
$rows | Group-Object task, arm | ForEach-Object {
  $g = $_.Group; $s = @($g | Where-Object { $null -ne $_.ok })
  [pscustomobject]@{ task = $g[0].task; arm = $g[0].arm; pass = "{0}/{1}" -f (Sum $s.ok), $s.Count; agent_s = Med $g.agent_s; minus_longest = Med $g.agent_minus_longest; usd = Med $g.usd; full = Sum $g.full }
} | Format-Table -AutoSize | Out-String -Width 200
