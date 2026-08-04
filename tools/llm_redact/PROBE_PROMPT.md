# Preference elicitation — instructions for the worker model

You are reading one contributor's own agent-session transcript to find moments
where they corrected, overruled, or pushed back on the agent. The goal is to
turn those moments into a small number of questions whose answers become
durable working preferences.

You are not summarising the session. You are looking for friction.

## Signals worth a probe

| signal | what it looks like |
|---|---|
| `repeated_correction` | the contributor corrects the same behaviour more than once |
| `long_exchange` | many turns spent converging on something that should have been one turn |
| `late_rejection` | work is accepted for a while, then rejected near the end |
| `decision_reversal` | a decision is made, then reversed |
| `explicit_rule` | the contributor states a rule outright ("never do X", "always ask before Y") |
| `sustained_disagreement` | the contributor disagrees across several turns and does not concede |

A single mild correction is not a probe. Look for moments a reasonable person
would want the agent to remember next time.

## What a probe must contain

- `recap`: at most three sentences, self-contained, written in the language the
  contributor used in that exchange. Someone who never saw the session must
  understand the moment from the recap alone. Do not quote credentials, private
  personal detail, or anything that reads as sensitive.
- `question`: short, and answerable. Usually "Anything here you want the agent
  to remember?"
- `options`: two or three **mutually exclusive** candidate preferences, each
  grounded in what actually happened in that exchange. Do not invent generic
  advice. "Ask before editing anything under deploy/" is grounded; "communicate
  clearly" is not.
- `event_ids`: the source events the moment spans. These must be real ids from
  the input file — they are the evidence trail and are checked.
- `score`: 0-100, how strongly you think this is worth asking about. Used only
  for ranking.

## Output contract

Return **only** a JSON object, no prose, no markdown fence:

```
{
  "trajectory": "<the trajectory id you were given>",
  "probes": [
    {
      "event_ids": ["evt-000042", "evt-000045"],
      "timestamp": "2026-07-21T09:14:00Z",
      "signal": "repeated_correction",
      "score": 87,
      "turns": 6,
      "recap": "…",
      "question": "Anything here you want the agent to remember?",
      "options": [
        {"id": "A", "text": "…"},
        {"id": "B", "text": "…"}
      ]
    }
  ],
  "reviewed_turns": 183,
  "notes": ""
}
```

Rules:

- **At most 5 probes per trajectory.** Fewer is normal and better. A transcript
  with no real friction should return an empty `probes` array — that is a valid
  result, not a failure. Do not manufacture probes to look thorough.
- `reviewed_turns` must be the actual length of the `turns` array in your input
  file. Count it; do not estimate it.
- Every `event_ids` entry must appear in the input. Invented ids are dropped.
- Options must be things the *agent* could do differently, not things the
  contributor should do.
