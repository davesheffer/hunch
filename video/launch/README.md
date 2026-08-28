# Hunch v1.20 launch package

This directory turns the existing deterministic orders demo into one focused
launch: **the assistant sees the reason before it repeats the bug**.

The campaign is proof-led rather than star-led. A qualified star is a useful
side effect of someone understanding and trying Hunch; it is not a substitute
for a user receiving useful project memory.

## Deliverables

- [`script.md`](script.md) — the 90-second narration, shots, and edit notes.
- [`publish-copy.md`](publish-copy.md) — ready-to-review YouTube, LinkedIn,
  Show HN, and community copy.
- [`thumbnail.html`](thumbnail.html) — 1280×720 branded thumbnail source.
- `hunch-youtube-thumbnail.png` — rendered from that source before publishing.
- [`../tapes/`](../tapes/) — reproducible terminal B-roll.

## Release prerequisite

Do not launch while the public surfaces disagree. Before recording:

1. Publish stable `@davesheffer/hunch@1.20.0`.
2. Publish the matching GitHub `v1.20.0` release.
3. Confirm the README install command resolves to that stable version.
4. Replay all three tapes against the published package.
5. Confirm `hunch why` and the single opt-in `hunch conform --strict` receipt
   still match the narration.

The demo was last fully replayed on 2026-08-28 against published v1.19.0 and
current v1.20.0-rc.6 source. That proves the kit is current enough to finish;
it does not waive the stable-package replay above.

## Production order

1. Render the three VHS segments.
2. Record the two live assistant shots from [`script.md`](script.md).
3. Assemble the 90-second cut and add captions.
4. Upload to YouTube as **unlisted** and watch once on desktop and mobile.
5. Replace every `{{YOUTUBE_URL}}` placeholder in the launch copy.
6. Publish YouTube, then add its linked thumbnail to the repository README.
7. Publish the LinkedIn story first; it is Hunch's only currently proven
   external referrer.
8. Submit Show HN on a separate day when the maintainer can stay present and
   answer questions. Never coordinate votes.
9. Share one adapted technical post in one community whose current rules allow
   it. Do not cross-post the same launch copy.
10. Run at most five permission-respecting pilot invitations through the
    existing [`docs/outreach-pipeline.md`](../../docs/outreach-pipeline.md)
    workflow.

## README insertion after the video is public

Place this after the opening explanation and before `Start in five minutes`:

```html
<a href="{{YOUTUBE_URL}}">
  <img
    src="video/launch/hunch-youtube-thumbnail.png"
    alt="Watch the 90-second Hunch demo: project memory returns the reason before an AI coding assistant repeats an old bug"
  />
</a>
```

Do not commit the placeholder. The image should lead to a real, public video.

## Fourteen-day scorecard

Record the baseline immediately before publishing, then check at 24 hours,
seven days, and fourteen days:

| Signal | Why it matters | Initial target |
| --- | --- | ---: |
| Qualified GitHub stars | People chose to keep the project | 25 total |
| Public-repo visitors | The story reached the right audience | 150 unique |
| Pilot agreements | Someone will try Hunch on real work | 3 |
| Activations | A pilot later received useful saved memory | 1+ |
| External questions/issues | The project earned real participation | 3 |

Treat npm downloads and clone counts as directional only: registry scanners,
CI, and repeated release activity can inflate them. Never buy stars, trade
stars, mass-message maintainers, create promotional issues, or ask anyone to
coordinate an upvote.
