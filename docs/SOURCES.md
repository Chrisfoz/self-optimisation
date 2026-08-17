# Reference Sources

Background reading for [Model-Release-Driven Software Improvement](../Model-Release-Driven-Software-Improvement-Paper-Outline.md).

The PDFs themselves are held locally and excluded from version control (see `.gitignore`) — they are third-party publications. Retrieve them from the links below.

## Self-improving agents and evolutionary search

| Work | Notes | Where to find it |
|---|---|---|
| Darwin Gödel Machine | Self-modifying coding agent with an archive of prior variants. Relevant to §2.2 and the failure-memory component (§3.9). | arXiv — search "Darwin Gödel Machine" |
| Huxley–Gödel Machine: Human-Level Coding | Follow-on to DGM; relevant to §2.2 positioning. | arXiv |
| AlphaEvolve | Evolutionary code discovery driven by an LLM proposer plus automated evaluator. Direct precedent for the proposer/evaluator split (§3.5, §3.8). | DeepMind publication |
| The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery | End-to-end automated research loop; relevant to §2.2 and the campaign lifecycle (§4). | arXiv |
| Agent Hospital: A Simulacrum of Hospital with Evolvable Medical Agents | Agent self-evolution through accumulated experience; relevant to §3.9 memory. | arXiv |

## Test-time adaptation and learned memory

| Work | Notes | Where to find it |
|---|---|---|
| Self-Adapting Language Models (SEAL) | Models generating their own finetuning data. Contrast case: adapting the *model* vs. adapting the *project* (§2.2 distinction). | arXiv |
| Self-Rewarding Language Models | Model-as-judge training loop. Relevant to evaluator-integrity concerns (§3.7, §8 evaluator gaming). | arXiv |
| Titans: Learning to Memorize at Test Time | Neural long-term memory at inference. Relevant to §3.9. | arXiv |
| Nested Learning: The Illusion of Deep Learning Architectures | Architectural framing of multi-timescale learning. | arXiv |

## Framing and harness design

| Work | Notes | Where to find it |
|---|---|---|
| The Bitter Lesson — Rich Sutton | The scaling-over-handcrafting argument that motivates treating model releases as exogenous capability events (§1.2). | http://www.incompleteideas.net/IncIdeas/BitterLesson.html |
| Harness Engineering for Self-Improvement — Lilian Weng (Lil'Log) | Directly on harness design around a fixed model. Closest prior framing to this paper's kernel. | https://lilianweng.github.io/ |

## Still to source

Cited in the outline (§2) but not yet in `docs/`:

- SWE-agent, OpenHands, Aider; SWE-bench (§2.1)
- CORAL, EvoAgentX, AFlow, Agent Lightning, OpenEvolve (§2.2)
- Inspect, Vivaria, ControlArena (§2.4)
- Autonomic computing / MAPE-K loop (§2.5)
- GitHub Agentic Workflows (§2.6 comparison table)
