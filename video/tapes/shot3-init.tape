# Shot 3 — sixty seconds to memory.
# Prereqs: npm i -g @davesheffer/hunch
#          video/demo/setup.sh ~/hunch-video-demo --stage shot3
Output shot3-init.mp4
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

Type "hunch init"
Enter
Sleep 6s

Type "git add -A && git commit -m 'refactor: route orders through the service layer for auth + batching'"
Enter
Sleep 3s

Hide
Type "clear"
Enter
Show

Type "hunch sync"
Enter
Sleep 8s

Type "hunch now"
Enter
Sleep 5s

Hide
Type "clear"
Enter
Show

Type "hunch why app/api/orders.py"
Enter
Sleep 8s
