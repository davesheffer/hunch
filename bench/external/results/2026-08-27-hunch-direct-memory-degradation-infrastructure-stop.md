# Direct memory degradation benchmark: infrastructure stop

The frozen v1 protocol at commit `feacaca` was launched for repeats 1, 2, and 3.
All three stopped before completing replacement round one, and no QA call ran.
This is not an experimental result.

Each Claude Code invocation used JSON Schema constrained output with
`--max-turns 1`. Claude produced a structured-output tool call, but the CLI
requires another protocol turn to finalize that structured response. It exited
with subtype `error_max_turns`, stop reason `tool_use`, and terminal reason
`max_turns` in all three repeats. The frozen runner correctly classified and
preserved these as infrastructure failures with zero checkpoints and zero QA
calls.

No memory outcome was exposed or scored. A v2 protocol may fix only this
pre-outcome transport incompatibility by allowing two CLI turns, then freeze a
new runner hash and new output filenames before execution. The three v1 failure
records will not be overwritten or included as repeats.
