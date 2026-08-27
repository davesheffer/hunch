# Capacity stress v3: protocol stop

All three v3 repeats stopped after five completed replacement checkpoints and
before any QA call. This is not a memory-accuracy result.

At checkpoint five every generated memory was 93 words. On the next update,
each repeat returned at least one 101-word memory against the frozen 100-word
hard limit. The failing case varied by rotated order: Fable in repeat 1, Aster
in repeat 2, and Birch in repeat 3. The runner correctly rejected the treatment
deviation and preserved the partial evidence.

The v3 update prompt simultaneously said to preserve every fact and remain
under the cap. Once the growing text reached capacity, the model chose
completeness and exceeded the limit by one word instead of consolidating. Since
no downstream outcome was generated or inspected, a separately frozen v4 may
clarify that the cap takes priority, request compact key-value prose with
headroom, and preserve every case, score, gate, and decision rule. V3 files will
not be overwritten or counted as repeats.
