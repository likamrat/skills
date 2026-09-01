# Anti-slop writing and visual standard

Read this file before producing any forward deployed engineering (FDE) report, deck, case study, or durable Markdown artifact.

Remove writing and visual habits that conceal weak thinking.

## Writing rules

### Use a human-first drafting and editing loop

Use Peter Yang's [25/50/25 writing heuristic](https://creatoreconomy.so/p/use-my-no-ai-slop-skill-to-remove-20-ai-slop-patterns) for substantial narrative artifacts:

1. The FDE supplies the opening 25%: rough observations, failures, surprises, disagreement, opinion, and source facts.
2. The agent supports the middle 50%: organization, missing-evidence checks, alternatives, and a draft built only from approved source material.
3. The FDE owns the final 25%: verify facts, restore natural voice, sharpen the opinion, remove portable prose, and approve the artifact.

The percentages describe responsibility and sequence, not a literal word-count requirement. Do not ask the model to invent the human opening or perform the final approval.

### Separate detection from editing

Detection names the pattern, quotes the exact text, explains why it weakens the artifact, and proposes a local repair. It does not rewrite the document.

Editing uses the minimum effective change. Preserve vocabulary, cadence, bluntness, humor, uncertainty, useful repetition, and uneven polish when they belong to the author. Keep names, dates, numbers, quotes, evidence IDs, and technical terms fixed unless the evidence changes.

Run detection again after editing. Check that the change removed the pattern without flattening the author's voice or altering a fact.

For a detect-only request, stop after the findings. For an edit request, return the complete edited artifact and a short `What changed` note.

### Test portability

Ask whether a sentence could move unchanged to an unrelated engagement. If it could, add the actor, system, evidence, mechanism, constraint, or consequence that makes it belong here. Delete it if none of those details exist.

Use active voice and direct verbs. Show importance through measured consequence, risk, cost, authority, or decision impact instead of telling the reader that something is important.

### Lead with the decision

Open with:

- current gate;
- consequential finding;
- recommendation;
- decision owner.

Do not open with background, market context, a mission statement, or a summary of what the document will cover.

### Use evidence-bearing sentences

Prefer:

> The workflow log records recommendation and authorization as separate events above $25,000. `[log-001]`

Avoid:

> The current process presents a significant opportunity to leverage AI and transform operations.

Prefer concrete nouns, verbs, numbers, sources, and consequences to adjectives.

### Keep categories separate

Label:

- observed fact;
- stakeholder report;
- inference;
- recommendation;
- open question;
- decision.

Do not blend them into polished narrative.

### Remove stock language

Do not use:

- chatbot greetings or praise;
- throat-clearing;
- `in today's rapidly evolving landscape`;
- `delve into`;
- `unlock the potential`;
- `leverage AI`;
- `navigate the complexities`;
- `at its core`;
- stock `not just X, but Y` contrasts that add drama without a real distinction;
- `game changer`;
- `paradigm shift`;
- `seamless integration`;
- `robust solution`;
- `transformative journey`;
- `in conclusion`;
- `key takeaways`;
- `the road ahead`;
- unsupported superlatives.
- inflated AI vocabulary such as `foster`, `utilize`, `robust`, `transformative`, `tapestry`, `realm`, `paramount`, and `harness`.

Treat `just`, `honestly`, `simply`, `actually`, `truly`, `fundamentally`, `importantly`, `crucially`, `inherently`, and `inevitably` as review triggers rather than automatic deletions. Keep one when it carries real emphasis, uncertainty, contrast, or recognizable voice.

The linter also names these repairable patterns:

| Pattern | Typical failure | Repair |
|---|---|---|
| Empty preface | `It is worth noting` delays the claim | Delete the preface |
| Faux insight | `What most people get wrong` performs expertise | State the evidence-backed claim |
| Colon reveal | `The key:` adds theatrical timing | Write a plain sentence |
| Superficial analysis | A trailing `highlighting` clause labels meaning without showing it | Name the mechanism or consequence |
| Importance puffery | `Marks a pivotal moment` assigns significance without evidence | State the fact and consequence |
| Interpretive metadiscourse | `The key point is` tells the reader how to react | Supply evidence or delete it |
| Weasel attribution | `Experts agree` hides the source | Name the source or remove the claim |
| Fake-strong verb | `Serves as` replaces a clearer verb | Use `is`, `has`, or the direct action |
| Negative listing | Repeated `Not this. Not that.` creates cadence without content | State the positive claim once |
| Dramatic fragmentation | Sentence fragments simulate emphasis | Join them unless the cadence is genuinely the author's |
| Rhetorical setup | `What if I told you?` delays the point | Make the point |
| Recap ending | `In conclusion` repeats prior material | End on the decision or next action |

### Write from a durable point of view

Do not position a repository, skill, or method as:

- `the first role` or `the first collection`;
- `new`, `current`, or `upcoming` without a dated release context;
- one item in a promised future catalog;
- an `operating system`, `engine`, `flywheel`, or other metaphor in place of a procedure.

Describe what exists, what it does, and where it lives. Let the catalog show growth instead of promising it.

### Name the mechanism

Replace labels such as `trusted outcome`, `compounding learning`, `product leverage`, and `stable seam` with the observable mechanism:

- who owns the outcome;
- what evidence changes a decision;
- which interface or component is reused;
- how field evidence reaches product;
- which control prevents or contains failure.

Replace generic labels:

- `Key takeaways` -> `Decisions`
- `Opportunities` -> the specific outcome or finding
- `Challenges` -> `Risks and controls`
- `Next steps` is acceptable only with owner, date, dependency, and definition of done

### Control rhythm

- Prefer short paragraphs, but do not turn every sentence into a one-line slogan.
- Use bullets for genuinely parallel items.
- Avoid repeated three-item rhetorical lists.
- Do not use em dashes.
- Use bold for scanability, not drama.
- Do not restate the executive summary in the conclusion.

### Preserve uncertainty

Use `Unknown`, `Unassigned`, `Not scheduled`, ranges, and confidence labels when warranted. Do not smooth gaps into certainty.

## Report rules

- Three to five findings are usually enough.
- Each finding is atomic and evidence-linked.
- Findings describe what is true; recommendations describe what to do.
- Report only artifacts available at the current phase.
- Show severe failures and residual risk in the main body.
- Separate projected value from realized value.
- Do not claim adoption from launch, login, or pilot participation alone.
- Do not create a closing "vision" section unless it supports a named decision.

## Slide rules

- One assertion per slide.
- Use assertion titles: `Design is blocked by two missing facts`, not `Findings`.
- Use the fewest slides that support the decision.
- Prefer workflow diagrams, evidence tables, and measured charts over icons or decorative imagery.
- Do not use stock AI art, glowing brains, robots, gradients, or ornamental network diagrams.
- Use one accent color, one risk color, and neutral backgrounds.
- Keep body text large enough to read in a room.
- Put evidence IDs on the slide or in speaker notes.
- Never hide severe risk in the appendix.
- Delete empty sections instead of filling them with generic prose.
- Customer and internal decks are separate artifacts, not the same deck with hidden slides.

## Final editing pass

1. Detect named patterns without rewriting.
2. Delete any sentence that does not change a decision or understanding.
3. Replace abstract nouns with the actor, system, action, or consequence.
4. Remove claims that lack evidence.
5. Replace invented owner/date with `Unassigned` / `Not scheduled`.
6. Check that each slide title states its message.
7. Apply the portability test to every paragraph.
8. Run:

```text
node scripts/lint-readout.mjs --profile report path/to/output.md
```

9. Render every slide and inspect overflow, hierarchy, contrast, and internal-only content.
10. Compare the edited text with the human source notes and approve the minimum effective change.

If the linter flags a phrase used as literal text or quoted source material, verify the context before suppressing it. Prefer a no-op to an unnecessary rewrite.

The linter catches named patterns and a small set of generic evidence-free claims. It cannot judge whether every sentence is specific, useful, or true. The accountable FDE must still perform the final semantic and visual review.

The named-pattern taxonomy and 25/50/25 heuristic adapt ideas from Peter Yang's MIT-licensed No AI Slop skill. See [third-party notices](../THIRD_PARTY_NOTICES.md).
