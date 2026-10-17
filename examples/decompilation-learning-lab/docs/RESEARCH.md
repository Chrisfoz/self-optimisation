# Evidence check — 17 October 2026

The direction is credible: executable feedback makes a reconstruction problem
easier to judge automatically. Separate the following claims carefully.

| Term | Meaning |
|---|---|
| Disassembly | Machine instructions represented as assembly |
| Decompilation | Reconstruction of higher-level code from compiled evidence |
| Matching decompilation | Reconstructed code produces matching machine code with the intended toolchain and comparison rules |
| Behavioral reimplementation | Reproduces observed behavior, potentially with unrelated internals |
| Static recompilation | Translates existing machine code to another target; does not necessarily recover maintainable original source |
| Runtime refinement | Iteratively improves candidate artifacts using feedback |
| Learned self-improvement | Changes model weights or a learned strategy; not demonstrated by simply running a repair loop |

## Primary accounts and research

1. Chris Lewis, **Decompiling a Nintendo 64 Game in 84 Days**, 26 August 2026:
   https://blog.chrislewis.au/decompiling-a-nintendo-64-game-in-84-days/index.html
   The author reports a complete matching Snowboard Kids decompilation with
   substantial human contributions. This supports faster matching work, not
   one-click recovery of an arbitrary modern application.
2. Maurice Heumann, **500+ Billion Tokens Later: Letting AI Agents Decompile
   A First-Person Shooter**, 9 October 2026:
   https://momo5502.com/posts/2026-10-09-game-decompilation/
   The author reports readable but semantically incorrect early output, then a
   shift to machine-checkable matching. Final self-reported coverage: 99% of
   functions present and 83% byte exact. Code is private, so these are the
   author's claims, not independently reproduced results here. The lesson for
   this project is to protect the oracle and distinguish progress from fidelity.
3. Liu et al., **Binary Decompilation LLM with Feedback-Driven Multi-Turn
   Refinement**, arXiv preprint, 15 June 2026:
   https://arxiv.org/abs/2606.16162
   Studies compilation, execution and I/O feedback as iterative training and
   refinement signals. Our lab demonstrates runtime refinement, not their
   reinforcement-learning training method.
4. Liu, Raff and Micinski, **When LLM Decompilers Recompile More and Preserve
   Less**, arXiv preprint, 4 September 2026:
   https://arxiv.org/abs/2609.05370
   Reports behavior diverging even when shipped tests pass. Motivates varied
   assessments and explicit domain limits. Compilability is not fidelity.
5. PhotoCraft's own project description:
   https://github.com/storytold/photocraft
   Describes a clean-room reimplementation written in Rust. The launcher also
   describes the suite as written from scratch:
   https://github.com/storytold/craft-launcher
   Therefore the prominent Adobe-clone story is not evidence, on these
   descriptions, that Adobe's original binaries or source were recovered.

## Reddit: interest and claims, not a benchmark

- Game developer discussion, 13 October 2026:
  https://www.reddit.com/r/gamedev/comments/1x3uitu/ai_agents_just_decompiled_an_n64_game_in_84_days/
- Claimed StarFox/StarFox 2/Sonic CD ports, 12 October 2026:
  https://www.reddit.com/r/ClaudeAI/comments/1x3nkty/opus_55_is_insane_at_decompilation_ports/
- Adobe-clone discussion and disputed feature-parity claims, 10 October 2026:
  https://www.reddit.com/r/aiwars/comments/1x2mihm/thoughts_on_the_adobe_decompclone/

These establish active discussion and divergent user experiences. They do not
establish a growth rate, complete product fidelity or a guaranteed one-year
timeline. No posted binary, ROM, decompiled code or asset was imported.

## Next-year hypothesis

Expect more agent-assisted software understanding and migration where an
accessible binary, a reproducible compiler/toolchain and a strong oracle exist.
The opportunities extend beyond games to legacy maintenance and compatibility.
That is a forecast, not a measured result of this small lab. Obfuscation,
stateful behavior, network services, undocumented data and missing validation
remain obstacles. Original source is not uniquely recoverable from binaries.
