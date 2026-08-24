# Writing quality

## Human-first sequence

Use Peter Yang's 25/50/25 heuristic for substantial readouts:

1. The forward deployed engineer (FDE) supplies rough observations, failures, surprises, disagreement, opinion, and source facts.
2. The agent organizes the material, checks gaps, tests alternatives, and drafts only from approved evidence and human context.
3. The FDE verifies facts, restores natural voice, sharpens the opinion, and approves the artifact.

Treat the percentages as a sequencing heuristic, not a word-count requirement. The model cannot supply the human opening or final approval.

## Detect before editing

Detection names a pattern, quotes the exact text, explains why it weakens the readout, and proposes a local repair. It does not rewrite the deck.

Editing uses the minimum effective change. Preserve the author's vocabulary, cadence, bluntness, humor, uncertainty, useful repetition, and uneven polish. Keep names, dates, numbers, quotes, evidence IDs, and technical terms fixed unless the source changes.

After editing, run detection again and compare the result with the human source notes.

For a detect-only request, stop after the findings. For an edit request, return the complete edited artifact and a short `What changed` note.

The linter names empty prefacing, inflated vocabulary, faux insight, colon reveals, superficial analysis, importance puffery, interpretive metadiscourse, unnamed attribution, fake-strong verbs, negative listing, dramatic fragmentation, rhetorical setups, fake-profound endings, recap endings, em dashes, and report exclamations. It treats often-empty adverbs as review prompts because some carry real voice or contrast.

## Tests

- **Portability:** Could this sentence move unchanged to an unrelated customer? If yes, add the actor, system, evidence, mechanism, constraint, or consequence. Delete it when none exists.
- **Source protection:** Did the edit alter a name, date, number, quote, evidence ID, or technical term?
- **Directness:** Does the sentence use active voice and a direct verb?
- **Importance:** Does evidence show the consequence, or does the prose merely label it important?
- **Voice:** Does the result still sound like the person who supplied the judgment?

Run:

```text
node scripts/lint-writing.mjs --profile report path/to/output.md
```

The linter reports named patterns and a suggested repair. Review findings in context; quoted sources may remain unchanged.

The editing concepts and pattern taxonomy adapt Peter Yang's MIT-licensed No AI Slop skill. See [third-party notices](../THIRD_PARTY_NOTICES.md).
