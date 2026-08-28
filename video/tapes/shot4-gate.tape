# Shot 4 — the gate (terminal beats; the agent segment is Screen Studio/OBS).
# Prereqs: video/demo/setup.sh ~/hunch-video-demo    (full stage)
# The full rig already carries the explicitly trusted invariant.
Output shot4-gate.mp4
Set FontSize 18
Set Width 1920
Set Height 1080
Set Padding 40
Set TypingSpeed 55ms
Set Shell bash

Hide
Type "cd ~/hunch-video-demo && export HUNCH_SYNTH_PROVIDER=deterministic && clear"
Enter
Show

Type "# baseline: the trusted service boundary holds"
Enter
Type "hunch conform"
Enter
Sleep 6s

Type "# the assistant's clean-looking shortcut, replayed:"
Enter
Type "git restore --source agent-shortcut -- app/api/orders.py"
Enter
Sleep 2s

Type "hunch conform --strict"
Enter
Sleep 9s

Type "git checkout -- app/api/orders.py && hunch conform"
Enter
Sleep 7s
