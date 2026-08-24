# Evidence and safety

Read this file when handling sources, customer data, production recommendations, or public FDE claims.

## Evidence classes

Use these labels:

| Class | Meaning | Allowed use |
|---|---|---|
| `direct_observation` | Agent or authorized participant observed it | Strong evidence within observation limits |
| `system_record` | Log, database, ticket, document, or measured result | Strong if provenance and completeness are known |
| `stakeholder_report` | Named stakeholder described it | Attribute; check incentives and corroborate |
| `first_party_public` | Company or practitioner describes own work publicly | Attribute; account for marketing bias |
| `secondhand` | Source reports another party's experience | Context only unless corroborated |
| `inference` | Reasoned conclusion from evidence | Show reasoning and disproof condition |
| `synthetic` | Invented for teaching or testing | Never present as customer reality |
| `recommendation` | Proposed action | Tie to evidence, risk, and owner |

Confidence is separate from class. A detailed secondhand story is still secondhand.

## Claim discipline

For consequential claims:

```text
Claim:
Evidence class:
Source:
Observation date/context:
Confidence:
Contrary evidence:
What would disprove it:
Decision affected:
```

Do not:

- turn a speaker's hypothesis into company policy;
- treat an illustrative number as a threshold;
- turn a job-posting aspiration into proven practice;
- cite a summary as if it were the underlying source;
- fill absent details from a similar company or case;
- repeat compensation, growth, or failure-rate claims without methodology.

## Customer data rules

1. Confirm authorization and intended use before accessing customer material.
2. Minimize collection and copy only what the decision needs.
3. Preserve classification, residency, retention, and deletion requirements.
4. Redact secrets and personal or regulated information from artifacts.
5. Do not send restricted data to an unapproved model, tool, or service.
6. Use least-privilege, time-bounded credentials.
7. Record data lineage for eval and production cases.
8. Separate synthetic test data from customer evidence.
9. Never place customer data in a public skill, repository, or benchmark.

## AI production stops

Block or bound autonomy when:

- outputs affect safety, rights, money, employment, healthcare, legal status, or mission-critical operations without accountable human control;
- the system cannot explain which source data and policy drove an action;
- prompt injection or untrusted tool output can cross a permission boundary;
- the eval set excludes affected cohorts or known rare failures;
- model confidence is being treated as calibrated probability without evidence;
- monitoring cannot distinguish model, tool, data, and policy failure;
- the system cannot stop, roll back, or recover;
- users cannot contest or override a consequential action.

## Public research baseline

These sources informed this skill. Re-check them before relying on time-sensitive facts.

### First-party and practitioner material

- Palantir, "Dev versus Delta": https://blog.palantir.com/dev-versus-delta-demystifying-engineering-roles-at-palantir-ad44c2a6e87
- Kevin Bai, "Forward Deployed Engineering 101": https://www.youtube.com/watch?v=KwhgfwOSToQ
- Colin Jarvis, OpenAI FDE interview: https://www.youtube.com/watch?v=cBD7_R-Cizg
- Greg Isenberg and Vas, FDE discussion: https://www.youtube.com/watch?v=zXysLUTLjw4
- Google SRE, postmortem culture: https://sre.google/sre-book/postmortem-culture/

### Representative requisitions observed in August 2026

- Palantir FDSE: https://jobs.lever.co/palantir/dab396d4-2f14-4796-aac0-0d82883dccf0
- Scale AI FDE: https://job-boards.greenhouse.io/scaleai/jobs/4593571005
- Vercel FDE: https://vercel.com/careers/forward-deployed-engineer-5752684004
- Sixfold FDE: https://job-boards.greenhouse.io/sixfold/jobs/5234031008
- Caylent FDE: https://job-boards.greenhouse.io/caylent/jobs/5973732004
- Redapt FDE: https://job-boards.greenhouse.io/redapt/jobs/5396488008
- Databricks public-sector FDE: https://www.databricks.com/company/careers/professional-services-operations/sr-forward-deployed-engineer-fde---public-sector-8423296002

Job descriptions show desired operating models and hiring signals. They do not prove day-to-day practice.

### Writing and editing material

- Peter Yang, [Use My /No-AI-Slop Skill](https://creatoreconomy.so/p/use-my-no-ai-slop-skill-to-remove-20-ai-slop-patterns)
- Peter Yang, [No AI Slop skill](https://github.com/petergyang/no-ai-slop), version 1.0.6

## Source boundaries to preserve

- Kevin Bai's talk supplies a fit model and platform-reuse argument. He explicitly does not describe current Anthropic operations.
- Colin Jarvis supplies firsthand OpenAI examples of taking work from discovery through production with evals.
- The Greg Isenberg/Vas material describes an audit, evaluation, and deployment sequence. Its compensation and timeline claims lack verification.
- The "FDE in 30 Days" PDF is derivative learning material, not independent evidence.
- Public job posts show role breadth: product-generating, billable services, domain, migration, infrastructure, and field-operations variants.
