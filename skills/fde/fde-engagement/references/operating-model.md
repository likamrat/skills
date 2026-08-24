# FDE operating model

Read this file when qualifying an engagement, classifying a role, designing a team, or diagnosing role drift.

## Working definition

Forward deployed engineering is an operating model in which customer-facing engineers are responsible for moving a named customer outcome from discovery through production in the customer's environment and for returning reusable field evidence to the vendor's product or platform.

Production responsibility and a documented path for field evidence to reach product distinguish FDE from adjacent roles. Customer proximity alone does not.

## Classification

| Model | Production responsibility | Customer embedding | Field evidence reaches product | Completion condition |
|---|---:|---:|---:|---|
| Classical FDE | Yes | High | Required | Outcome runs in production, an owner accepts operations, and reusable findings have a product disposition |
| AI workflow deployment | Usually | High | Optional | Workflow runs with evals, controls, and an operating owner |
| Professional services | Yes | Medium to high | Helpful, not structural | Contracted deliverable is accepted and handed off |
| Standard implementation | Configuration-heavy | Medium | Product capability already exists | Product is configured, adopted, and assigned an owner |
| Solutions architecture | Usually no | Medium | Indirect | Architecture, proof, or recommendation |
| Sales engineering | Demo or proof only | Medium | Indirect | Technical confidence supporting a sale |
| Product engineering | Yes | Low customer embedding | Direct | Shared product capability |
| Forward field operations | Hardware or infrastructure | Very high | Product feedback expected | Deployed and supported field system |

State the model instead of stretching the FDE label.

## Fit test

### Strong FDE fit

- The outcome has enough economic or mission value to justify embedded senior engineering.
- The product or problem is technically complex.
- Buyer or user implementation capacity is materially lower than the complexity requires.
- Workflow, data, policy, or infrastructure constraints can be learned only inside the real environment.
- A reusable platform exists or is being built.
- Field discoveries can become shared primitives, product features, or research learning.
- The economics support senior engineering time.

### Weak FDE fit

- A standard configuration or documented integration solves the problem.
- The customer can implement independently.
- The engagement exists primarily to rescue a weak sales process.
- Every deliverable will remain customer-specific.
- No product team will receive field learning.
- The outcome is too small or vague to justify embedded engineering.
- No eventual owner can operate the result.

## Two kinds of judgment

The work needs both:

- **Commercial judgment:** workflow, incentives, cost, risk, adoption, stakeholder dynamics, and business value.
- **Technical judgment:** architecture, models, systems, APIs, data, code, security, reliability, evals, and operations.

Do not make one person responsible for every commercial and technical judgment. Build a team whose combined strengths cover both areas and make ownership explicit.

Useful team roles may include:

- engagement lead or senior FDE;
- implementation FDE;
- domain expert;
- product manager or product engineer;
- security, data, or platform specialist;
- customer operator and technical owner.

Avoid a single person becoming the only holder of customer context.

## Role variants

Classify the variant before applying advice:

- **Embedded R&D:** novel customer work tests a product or research hypothesis.
- **Platform adoption:** build on an existing platform and create reusable accelerators.
- **Vertical/domain FDE:** domain expertise is as important as general software depth.
- **AI-agent FDE:** workflow allocation, evals, tool permissions, and bounded autonomy dominate.
- **Public-sector/defense FDE:** clearance, field conditions, hardware, and mission assurance may dominate.
- **Services-partner FDE:** delivery is billable; reusable artifacts protect against pure linear scaling.
- **Migration/modernization FDE:** production code and enablement focus on a strategic platform transition.

## Success scorecard

Never reduce success to one metric.

### Customer outcome

- time to first meaningful value;
- realized revenue, cost, risk, or throughput change;
- output quality and failure severity;
- adoption breadth and depth;
- post-handoff incidents and re-engagement.

### Delivery health

- elapsed time and FDE effort;
- blocked time and dependency latency;
- security and reliability findings;
- human-review burden;
- maintenance cost and rollback readiness.

### Product reuse

- reusable component or pattern rate;
- repeated evidence across customers;
- field-surfaced product changes;
- bespoke maintenance load;
- productization decision latency.

### Team health

- context shared across the pod;
- sustainable travel and workload;
- documentation and handoff quality;
- escalation quality;
- burnout and hero dependency.

## Role-drift diagnostics

| Anti-pattern | Evidence | Corrective action |
|---|---|---|
| Unbounded bespoke delivery | Bespoke effort does not decline; product receives no learning | Require a reuse review and product owner |
| Customer-specific architecture | Each deployment has a unique architecture and upgrade path | Define shared interfaces and components |
| Single-person dependency | One person owns all context and emergencies | Pair coverage, runbooks, rotation, explicit ownership |
| Demo without production plan | Demos ship quickly while defects rise and no production path exists | Label demo code, fund hardening, gate rollout |
| Single-sponsor dependency | One champion carries all legitimacy | Build operator, technical, and executive relationships |
| Field evidence does not reach product | FDE cannot name product changes influenced | Track field evidence, product decisions, and owners |
| Customer request overrides scope | The loudest request becomes the roadmap | Tie scope to outcome, evidence, and reuse |
| Usage without outcome | Usage rises without business change | Measure realized outcomes and total operating cost |
| Launch mistaken for adoption | Launch metrics replace durable use | Measure repeat use, verification, and workflow dependence |
| Unsustainable workload | Travel, context switching, and emergencies become normal | Limit concurrent engagements and rotate into product work |
