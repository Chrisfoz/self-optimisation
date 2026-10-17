# Learner evidence

Generated from the compiled teaching binary. The source is retained separately for audit and reproducibility.

Recover `int score_tick(int coins, int streak, int hazard)`. Only coins/streak 0..7 and hazard 0..1 are valid. The function has no state, external calls or side effects.

Compiler: gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0

Flags: `-std=c11 -O2 -fno-stack-protector -fno-asynchronous-unwind-tables`

```asm

score.o: file format elf64-x86-64


Disassembly of section .text:

0000000000000000 <score_tick>:
   0:	f3 0f 1e fa          	endbr64
   4:	89 d1                	mov    ecx,edx
   6:	8d 14 bf             	lea    edx,[rdi+rdi*4]
   9:	01 d2                	add    edx,edx
   b:	83 fe 02             	cmp    esi,0x2
   e:	8d 04 72             	lea    eax,[rdx+rsi*2]
  11:	0f 4e c2             	cmovle eax,edx
  14:	89 c2                	mov    edx,eax
  16:	d1 f8                	sar    eax,1
  18:	85 c9                	test   ecx,ecx
  1a:	0f 44 c2             	cmove  eax,edx
  1d:	c3                   	ret

```

## Public input/output probes

```json
[
  {
    "input": [
      0,
      0,
      0
    ],
    "output": 0
  },
  {
    "input": [
      0,
      4,
      0
    ],
    "output": 8
  },
  {
    "input": [
      1,
      0,
      0
    ],
    "output": 10
  },
  {
    "input": [
      1,
      4,
      0
    ],
    "output": 18
  },
  {
    "input": [
      2,
      0,
      0
    ],
    "output": 20
  },
  {
    "input": [
      2,
      4,
      0
    ],
    "output": 28
  },
  {
    "input": [
      3,
      0,
      0
    ],
    "output": 30
  },
  {
    "input": [
      3,
      4,
      0
    ],
    "output": 38
  },
  {
    "input": [
      4,
      0,
      0
    ],
    "output": 40
  },
  {
    "input": [
      4,
      4,
      0
    ],
    "output": 48
  },
  {
    "input": [
      5,
      0,
      0
    ],
    "output": 50
  },
  {
    "input": [
      5,
      4,
      0
    ],
    "output": 58
  },
  {
    "input": [
      6,
      0,
      0
    ],
    "output": 60
  },
  {
    "input": [
      6,
      4,
      0
    ],
    "output": 68
  },
  {
    "input": [
      7,
      0,
      0
    ],
    "output": 70
  },
  {
    "input": [
      7,
      4,
      0
    ],
    "output": 78
  }
]
```
