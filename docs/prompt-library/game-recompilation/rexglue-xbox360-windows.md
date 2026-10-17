# Xbox 360 → Windows static recompilation with ReXGlue

**Type:** user-supplied community prompt example  
**Added:** 18 October 2026  
**Status:** archived example; not an executed or validated game port

## Use

Replace the game, project directory, ISO path, GPU, controller and publication
placeholders before copying the prompt into a project session. The fenced text
below preserves the user's supplied example. Its approvals apply when executing
that future project; saving it here does not start the milestones.

The version pin and licence choice are part of the supplied prompt. Confirm the
pinned SDK's requirements, game compatibility and publication terms for the
specific project. “Stable 60 fps” is a goal, not a verified capability.

## Example prompt

```text
I want to statically recompile my own copy of <GAME> (Xbox 360) so it runs natively on my Windows PC.
Work in <C:\Project>. My ISO is at <path>. My GPU is <model>, my controller is <model>.

Approach (don't re-evaluate this):
- Use the ReXGlue SDK (pin a release tag, currently v0.10.0) as the base. It already provides the kernel, GPU
  (Direct3D 12) and audio. Do NOT write your own renderer or kernel layer.
- Start by building the SDK, running `rexglue init` and `rexglue codegen`, and booting the game to a title
  screen. Only then add features.
- Fix problems in the SDK as small, documented patches and keep them as a single diff file.

Ground rules:
- Never put game files in the repo: no ISO, XEX, pk4 or other data, and no generated recompiled code.
  The README must say users bring their own copy of the game.
- Measure before you change things. Reproduce bugs with a recorded input replay, log timing or a call
  stack, and keep a change only if the numbers improve. Remove experiments that did not help.
- If you are about to make a risky or outward-facing change (deleting, pushing, publishing, installing),
  ask me first. Do not run test builds while I am playing; I will tell you when I'm away.
- Tell me what you verified versus what you only assumed.

Build the project in this order, checking with me at each milestone:
1. SDK built and installed; the game boots to its title screen.
2. Crash fixes (missing function boundaries, floating-point exceptions, unregistered functions).
3. Input record/replay, so you can drive the game yourself.
4. Stable 60 fps with no hitches (measure frame times, not just the average).
5. Quality-of-life: in-game settings menu, "locate your ISO" prompt, desktop shortcut and icon.
6. Publish: GitHub repo (<account>, GPL-2.0-or-later, public/private), README, releases with source only.

Keep notes in a memory file as you go, and give me a short summary after each milestone.
```

## Provenance and verification

- Supplied by the repository owner as an example discussed on Reddit. No Reddit
  permalink was supplied; its origin, popularity and success claims are unverified.
- Checked the official [v0.10.0 release](https://github.com/rexglue/rexglue-sdk/releases/tag/v0.10.0)
  and documentation for [CLI commands](https://github.com/rexglue/rexglue-sdk/wiki/rexglue-CLI-Commands)
  and [getting started](https://github.com/rexglue/rexglue-sdk/wiki/Getting-Started)
  on 18 October 2026. The release exists and the documentation describes
  `rexglue init` and `rexglue codegen`; this is not a claim that the tag is
  perpetually current.
- SDK build, game boot, graphics/audio, controller compatibility, replay,
  performance and publication have not been verified by this repository.
- This is static recompilation (ahead-of-time translation), distinct from
  reconstructing original high-level source or training a self-improving model.
- No game files, generated recompiled code, SDK patches or releases accompany
  this prompt. This document is not automatically loaded by the improvement
  harness and changes no runtime policy.
