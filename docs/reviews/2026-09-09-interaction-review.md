# Interactive CLI milestone review

Reviewed CLI grammar, request preparation, initialization read models, terminal
adapter, dispatch and focused public tests. Changes were limited to the interaction
adapter/policy, initialization default identity and new regression tests.

## Material findings and fixes

- **Correctness: Ctrl-C and EOF hung in compiled Bun.** A standalone compiled
  adapter fixture under real pseudo-terminals remained alive at the first prompt
  after Ctrl-C and Ctrl-D; ordinary answers worked. Readline consumes terminal
  Ctrl-C before the process signal handler, and closing its interface did not
  settle the pending question. The adapter now rejects pending input on readline
  SIGINT, close/EOF and AbortSignal, then releases the interface/listeners. The
  same compiled fixture now exits promptly for all three cases.
- **Caller usability: default identity was not a slug.** A directory `My App.v2`
  produced an invalid default name. Initialization now derives `my-app-v2`, with
  `project` as the empty-slug fallback. Explicit identity and existing config
  identity remain authoritative and unchanged.
- **Correctness: prompt text allowed terminal controls.** Config-derived defaults,
  labels and messages could carry escape sequences or forged lines. Prompt text
  now strips terminal escape/control sequences; domain values remain intact.
  Detached-HEAD guidance and Production mismatch messages use the same formatter.
- **Failure contract: malformed context replies surfaced raw validation errors.**
  Read-only interaction replies now fail with safe `DAEMON_PROTOCOL` guidance.
- **Correctness: cancellation during a context read could prepare a mutation.**
  A regression aborted during the Production-context response and still received
  a prepared deployment. Interaction now checks cancellation before work, after
  reads/choices and before returning. The parent also owns the final CLI guard
  after diagnostic writes and immediately before mutation submission.

## Contract ledger findings

| Boundary | Inputs and effects | Failure/ownership policy | Verification |
| --- | --- | --- | --- |
| Terminal question | Supplied readable/writable streams and AbortSignal; owns readline lifetime and terminal writes | EOF, Ctrl-C and abort return CANCELLED; cleanup releases callbacks/interface; user response is owned text | EOF, pre-abort, prompt sanitization tests; compiled PTY Ctrl-C/Ctrl-D/answer |
| Request preparation | Runtime request, daemon client, interaction capability, output and signal | Read-only context lookup precedes mutation; malformed reply is DAEMON_PROTOCOL; cancelled preparation returns no request | Existing picker/init/mismatch tests plus malformed reply and mid-read cancellation regressions |
| Initialization discovery | Directory, requested identity and explicit Git runner; read-only source/config inspection | Config identity wins; absent identity uses normalized directory slug; inspection does not create Git | Directory punctuation/case regression and preserved configured name |
| Terminal text formatter | Plain string in; single-line display string out | Removes display controls only, no mutation or I/O | CSI, OSC clipboard, newline and carriage-return cases |

## Validation

Six new regressions were observed failing before fixes. Focused validation after
fixes: **20 tests passed, 154 assertions** across terminal interaction,
initialization slug, interaction policy and CLI tests. Existing checks continue to
cover help with zero daemon calls, non-TTY explicit Target requirements, explicit
Production Branch selection, configured/stopped Target choices and Git-creation
confirmation. No application/runtime operation was executed by the compiled PTY
fixture; its processes and terminal handles were cleaned up.

The typecheck invocation during this review found one unrelated in-progress
`tests/runtime-logs.test.ts` stream-literal error, reported to the parent. A full
repo validation remains the integration owner's responsibility after all agents'
changes settle.
