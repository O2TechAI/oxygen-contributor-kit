# Finding the moments worth asking about

Preferences are invisible while things go well. They become visible at friction: the contributor
wanted something they had never stated, did not get it, and pushed back. Score for that, not for
topic importance.

## Signals, strongest first

**`repeated_correction`** — the contributor corrected the same behaviour more than once. The
repetition is the point: once is a mistake, twice is an unmet expectation.

**`long_exchange`** — many consecutive turns on one question. Length is a proxy for a
gap between what the contributor assumed and what the agent assumed.

**`late_rejection`** — the contributor rejected finished work rather than a proposal. They
usually cannot say what they want up front, but recognize it immediately when absent.

**`decision_reversal`** — something agreed earlier was explicitly undone. The reason for the
reversal is a preference, and it is rarely written down anywhere else.

**`explicit_rule`** — the contributor stated a rule outright: "always", "never", "next time",
"from now on", "don't ever". Cheap to detect and nearly always genuine. Still worth a probe,
because the stated scope is usually narrower or broader than intended.

**`sustained_disagreement`** (meetings) — participants disagreed across several turns and then
converged. The resolution encodes a shared preference; the disagreement shows it was not obvious.

## Not signals

- Long output, large diffs, many tool calls. Volume is not friction.
- Errors the agent hit and fixed by itself. No contributor judgement was expressed.
- Topic keywords like "security" or "architecture". Importance of subject is not evidence of an
  unstated preference.
- Politeness or its absence. Terse contributors are not signalling more than verbose ones.

## Ranking and merging

Score each candidate 0–100, weighting how clearly a *transferable* preference could be recovered
— one that would apply to future work, not a one-off fact about this repository.

Then merge aggressively. Several moments frequently point at one preference; ask once with the
clearest evidence and attach the remaining event IDs to that probe. Three questions producing
three distinct preferences beats ten questions producing the same three.

Prefer coverage across time and across trajectories over ten probes from the single most
argumentative afternoon. The contributor is reviewing a project's arc, not one bad day.

## Calibrating the cap

Twelve probes is the default because it is answerable in one sitting. Push toward the low end
when probes are subtle or need long recaps, and toward the high end only when signals are strong
and mutually distinct. A contributor who abandons the queue halfway contributes fewer
preferences than one who answers six and finishes — an abandoned queue also leaves the
run in a half-annotated state that nobody returns to.
