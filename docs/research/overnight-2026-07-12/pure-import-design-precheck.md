# Pure Import Design Precheck

This read-only precheck addresses Claude finding O before implementation. It is
design evidence only; the implemented runtime gate must repeat the checks and
write a committed machine-readable report before preregistration or replay.

## Identity

- Local server commit: `6e1f0e898bd2415f8040e66a9439cfbec55b4893`
- Local package version: `0.4.128`
- Deployment claim: repository live-designated logic only; VPS byte identity is
  not claimed.

## Literal runtime graph

`dist/engine/champion.js` has no runtime import.

`dist/engine/rules/hedge01.js` imports only:

- `dist/engine/rules/ruleHelpers.js`
- `dist/engine/regime.js`
- `dist/engine/hwm.js`

Those three modules have no runtime import. No module in this five-file closure
contains `require(...)` or dynamic `import(...)`.

## SHA-256

| Module | SHA-256 |
|---|---|
| `dist/engine/champion.js` | `6945de8a44f06a5d0691ff81445928760030ead287058f4044d6a8ebba6aa84a` |
| `dist/engine/rules/hedge01.js` | `2956e5c85f25175c09fcc66f364b267c7066dfd72670ec64efb0e10f11bece4e` |
| `dist/engine/rules/ruleHelpers.js` | `2a83526f25cd5e58523d4ead9b67cd6d85805569094a2877f9863c2b48310737` |
| `dist/engine/regime.js` | `31a5a98a15e82cd1313e88dbef7ff273617eec4745b6fefaeffd40b68ed64dba` |
| `dist/engine/hwm.js` | `b9ad89c30014a0d384e2fc29a31d9d5292cdda2fe7c67141fbb8e42fd816791b` |

## Side-effect scan

No network, child-process, filesystem-write, cwd-mutation, or generic env-loader
token was found. One explicit non-secret feature-flag read exists:

`process.env.RULE_DISABLE_S12 !== "true"`

The design therefore freezes and allowlists only `RULE_DISABLE_S12=false`.
Every other env read remains invalid.

## Isolated import smoke test

Environment was rebuilt with only `TZ=UTC`, `LANG=C`, `LC_ALL=C`, and
`RULE_DISABLE_S12=false`. Absolute Node path `/usr/local/bin/node` imported both
modules successfully and returned:

```json
{"champion":"function","hedge01":"function"}
```

No signal or outcome function was invoked. This clears feasibility at the design
level; it does not replace the implemented static/runtime guard tests.
