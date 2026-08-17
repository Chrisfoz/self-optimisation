# Model-Release-Driven Software Improvement

## A Governed and Portable Harness for Autonomous Software Evolution

Advances produced by frontier-model laboratories can be systematically converted into verified improvements in existing software projects through a reusable, model-agnostic harness that separates proposal generation, execution, review, evaluation, and promotion.

This is not unrestricted recursive self-improvement. It is bounded, project-directed improvement using externally developed models under explicit evaluation and governance.

Projects can benefit from external AI investment without retraining their own foundation models.

The harness does not need to assume that a new model is superior. It only needs to create a fair opportunity for the new model to demonstrate project-specific value.

Different models may win different capabilities. The correct result may be a portfolio of task-specific models rather than the replacement of one global incumbent.

The approach may be applicable to:

- software maintenance;
- agent workflow improvement;
- data pipelines;
- creative systems;
- scientific optimisation;
- infrastructure;
- accessibility; and
- security remediation.

## Implications for Software Architecture

Projects prepared for autonomous improvement require:

- explicit constitutions;
- executable quality criteria;
- strong modular boundaries;
- observable outcomes;
- reversible deployment;
- machine-readable architecture; and
- durable decision records.

## Design Principles and Requirements

The system requirements should be presented before the components:

1. **Release-triggered, not release-trusting**
2. **Model and provider independence**
3. **Project portability**
4. **Constitution before generation**
5. **Bounded authority**
6. **Separation of duties**
7. **Evaluator integrity**
8. **Evidence before promotion**
9. **Reversible changes**
10. **Longitudinal learning**
11. **Reproducibility**
12. **Human control proportional to risk**

> The product code, constitution, and evaluator must not all be modifiable within the same campaign.

Changes to the harness, constitution, or evaluation system require a separate meta-governance process.

## 1. Introduction

### 1.1 Motivation

Explain the widening gap between:

- the rate at which frontier models acquire new capabilities; and
- the rate at which individual software projects can safely adopt those capabilities.

Most projects rely on manual experimentation, occasional model substitutions, or ad hoc prompting changes. Consequently, significant external research investment is not systematically converted into project-level improvement.

### 1.2 Core Insight

A model release is an exogenous capability event. It can be treated similarly to:

- a dependency release;
- a new compiler optimisation;
- a hardware improvement; or
- a new scientific instrument.

However, because model behaviour is stochastic and changes can introduce hidden regressions, conventional dependency-update automation is insufficient.

### 1.3 Contributions

The paper should claim five principal contributions:

1. **A new formulation:** model-release-driven software improvement as a distinct systems problem.
2. **A reusable architecture:** the ten-component improvement kernel.
3. **A governed campaign protocol:** separation between proposer, executor, reviewer, evaluator, and promoter.
4. **A project-adapter specification:** enabling the same kernel to operate across heterogeneous repositories.
5. **A multi-repository empirical evaluation:** measuring effectiveness, portability, safety, and cost across three independent projects.

## 2. Background and Related Work

Organise this section by research tradition rather than by listing products.

### 2.1 Autonomous Software Engineering

Cover:

- SWE-agent;
- OpenHands;
- Aider;
- automated program repair;
- repository-level coding agents; and
- SWE-bench and related benchmarks.

### 2.2 Self-Improving and Evolutionary Agents

Cover:

- Darwin Gödel Machine;
- AlphaEvolve and OpenEvolve;
- CORAL;
- EvoAgentX;
- AFlow; and
- Agent Lightning.

Distinguish self-modification of an agent from improvement of an external project.

### 2.3 Model Routing and Provider Abstraction

Cover:

- multi-provider gateways;
- quality/cost routing;
- capability registries;
- model lifecycle metadata; and
- provider-native versus normalised interfaces.

### 2.4 Agent Evaluation and AI Control

Cover:

- Inspect;
- Vivaria;
- ControlArena;
- model-graded evaluation;
- independent monitors;
- evaluator separation; and
- sandboxing and least privilege.

### 2.5 CI/CD, MLOps, and Autonomic Computing

Connect the proposal to:

- continuous integration;
- staged deployment;
- champion–challenger testing;
- feature flags;
- rollback;
- policy-as-code;
- self-adaptive systems; and
- autonomic computing's monitor–analyse–plan–execute loop.

### 2.6 Positioning Against Prior Work

| System | Release-triggered | Multi-provider proposals | Independent review | Project portable | Failure memory | Staged promotion |
|---|---:|---:|---|---:|---:|---:|
| DGM | No | Partial | Partial | No | Yes | No |
| CORAL | No | Yes | Grader separation | Partial | Yes | No |
| GitHub Agentic Workflows | Schedule/event | Yes | Configurable | Yes | Limited | Partial |
| Proposed system | Yes | Yes | Required | Yes | Yes | Yes |

This table will help establish the paper's novelty without claiming that every component is independently new.

## 3. System Architecture

This is the core architecture section.

### 3.1 Project Constitution

Defines:

- permitted change surfaces;
- forbidden files and operations;
- quality thresholds;
- security requirements;
- acceptable cost;
- human approval requirements;
- rollback rules; and
- promotion authority.

### 3.2 Context Compiler

Produces a task-specific project representation from:

- repository structure;
- dependency graph;
- key symbols;
- tests;
- architecture documents;
- current issues;
- previous campaign results; and
- operational constraints.

### 3.3 Model-Release Detector

Identifies:

- newly available models;
- new modalities or tool capabilities;
- pricing and context changes;
- preview-to-general-availability transitions;
- deprecations;
- provider alias changes; and
- regional or account-level availability.

It should distinguish a published model announcement from a model that is genuinely accessible to the harness.

### 3.4 Provider/Model Router

Preserves a common invocation contract while retaining:

- provider identity;
- model version;
- native capabilities;
- generation parameters;
- costs;
- latency; and
- provenance.

### 3.5 Parallel Proposal Stage

Produces multiple independently generated candidate improvements using:

- different models;
- different providers;
- varied strategies;
- alternative context selections; and
- potentially multiple proposal generations per model.

### 3.6 Bounded Patch Executor

Applies candidates inside isolated workspaces with:

- branch or worktree isolation;
- restricted credentials;
- network controls;
- resource limits;
- command policies; and
- complete execution logs.

### 3.7 Independent Reviewer

Reviews candidates without knowing which provider generated them, where practical.

Reviewer independence should include:

- separate context;
- preferably a different provider or model family;
- no access to hidden evaluator answers;
- explicit constitutional checks; and
- structured findings rather than an unqualified score.

### 3.8 Automated Evaluator

Combines:

- deterministic tests;
- static analysis;
- security scanning;
- performance benchmarks;
- cost and latency measurement;
- project-specific quality metrics; and
- human or model-based judgement only where deterministic metrics are insufficient.

### 3.9 Failure and Proposal Memory

Records:

- attempted changes;
- model and provider;
- context supplied;
- reviewer findings;
- test outcomes;
- failure classification;
- cost;
- promotion decision; and
- subsequent production outcome.

### 3.10 Staging and Promotion Layer

Supports:

- pull-request-only mode;
- shadow deployment;
- feature flags;
- canary release;
- human approval;
- automated rollback; and
- post-promotion monitoring.

## 4. Improvement Campaign Lifecycle

Describe the complete state machine:

1. Release detected
2. Release qualified
3. Relevant projects selected
4. Constitution loaded
5. Context compiled
6. Incumbent baseline measured
7. Candidate models assigned
8. Proposals generated in parallel
9. Candidates executed in isolation
10. Independent review completed
11. Automated evaluation completed
12. Candidates ranked
13. Winning candidate staged
14. Human or policy approval obtained
15. Candidate promoted or rejected
16. Outcome written to memory
17. Post-promotion monitoring performed

Every campaign should produce a signed or immutable campaign record.

## 5. Portability and Project-Adapter Model

Each project adapter may be expressed in a configuration such as:

```yaml
project:
  id:
  repository:
  default_branch:

constitution:
  allowed_paths:
  prohibited_actions:
  approval_class:

context:
  architecture_sources:
  token_budget:

evaluation:
  test_commands:
  quality_metrics:
  hard_constraints:
  promotion_thresholds:

deployment:
  staging_target:
  rollback_command:
```

Portability should itself be measured through:

- adapter lines of code;
- configuration volume;
- integration time;
- number of custom evaluator components;
- percentage of kernel code changed; and
- maintenance effort when the kernel is upgraded.

A successful portability result would require **no project-specific changes to the core kernel**.

## 6. Research Questions

### RQ1 — Effectiveness

Does a model-release-driven campaign produce more validated project improvements than a static single-model workflow?

### RQ2 — Proposal Diversity

Do parallel, multi-provider proposals improve promotion yield or improvement magnitude over repeated proposals from one model?

### RQ3 — Governance

Does independent review reduce regression and unsafe-promotion rates?

### RQ4 — Memory

Does proposal and failure memory reduce repeated unsuccessful approaches, cost, and time across successive campaigns?

### RQ5 — Portability

Can the same improvement kernel be applied across three heterogeneous repositories with limited project-specific engineering?

### RQ6 — Economics

What is the cost, latency, and compute consumption per successfully promoted improvement?

## 7. Metrics

Use metrics unique to the proposed methodology:

- **Release yield:** proportion of releases producing at least one promoted improvement.
- **Promotion precision:** proportion of promoted changes remaining acceptable after later audit.
- **Failure-recurrence rate:** repetition of previously recorded unsuccessful approaches.
- **Cost per accepted improvement.**
- **Portability burden:** effort required to connect each repository.
- **Reviewer agreement:** agreement between automated, independent, and human assessment.

## 8. Failure Analysis

Develop a taxonomy covering:

- syntactically valid but incorrect changes;
- test overfitting;
- evaluator gaming;
- context omission;
- fabricated dependencies;
- security regression;
- performance regression;
- excessive proposal scope;
- repeated failed approaches;
- reviewer–proposer correlation;
- model alias drift;
- provider outages;
- excessive campaign cost; and
- successful tests but degraded user value.

Include several detailed failure narratives, not just counts.

## 9. Security, Safety, and Governance

### Threat Model

Address:

- generated malicious code;
- prompt injection embedded in repositories;
- secret exfiltration;
- supply-chain attacks;
- manipulation of evaluators;
- unauthorised network activity;
- destructive commands;
- compromised project memory; and
- collusion or correlated errors between models.

### Controls

Describe:

- isolated execution;
- network deny-by-default;
- ephemeral credentials;
- immutable evaluator assets;
- branch protection;
- signed campaign records;
- scoped permissions;
- human approval classes;
- kill switches;
- rollback; and
- post-promotion monitoring.

## 10. Limitations and Threats to Validity

Acknowledge:

- only three repositories;
- repositories may not represent all software systems;
- imperfect independence between related model families;
- benchmark contamination;
- model and pricing changes during the study;
- subjective evaluation dimensions;
- dependence on existing test quality;
- substantial compute cost;
- limited observation of long-term production effects; and
- researcher involvement in repository and evaluator design.

## 11. Reproducibility and Open-Science Package

Publish:

- versioned kernel;
- adapter specification;
- campaign manifest schema;
- constitution schema;
- provider interfaces;
- container definitions;
- rejected and successful proposals;
- cost records; and
- statistical analysis scripts.

## 12. Conclusion

Model releases can be treated as triggers for controlled software-improvement experiments. The proposed architecture evaluates whether a reusable kernel can convert external model advances into measurable project improvements while preserving project constraints, reviewer independence, auditability, and reversible promotion.
