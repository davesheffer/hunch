# Shot 5 — team memory (works fully offline against the local bare repo).
# Prereqs: full rig at ~/hunch-video-demo (+ the -memory.git bare repo
#          setup.sh created next to it); ~/hunch-video-clone2 must not exist.
Output shot5-team.mp4
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

Type "hunch shared --repo ~/hunch-video-demo-memory.git --migrate"
Enter
Sleep 9s

Type "git add -A && git commit -m 'chore: move engineering memory to a private overlay'"
Enter
Sleep 3s

Type "# a teammate, five minutes later:"
Enter
Type "git clone ~/hunch-video-demo ~/hunch-video-clone2 && cd ~/hunch-video-clone2"
Enter
Sleep 4s

Type "hunch init"
Enter
Sleep 6s

Hide
Type "clear"
Enter
Show

Type "hunch why app/api/orders.py"
Enter
Sleep 8s
