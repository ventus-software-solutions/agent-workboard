---
id: fbr_20260812143216_78750600c
title: "COLA closeout crashes when the report has no line items"
owner: unassigned
status: todo
type: bug
source: fbr
fbr_ref: fbr_20260812143216_78750600c
priority: unset
labels:
module: '-'
created: 2026-08-12
---
# COLA closeout crashes when the report has no line items

Felix reported that closing out a COLA report with zero line items throws a 500.

## Reproduction

1. Create a COLA report
2. Delete every line item
3. Click **Close out**

```js
// the offending reduce has no initial value
const total = items.reduce((a, b) => a + b.amount);
```

## Notes

- Seen on live since the 2026-08-10 deploy
- Probably the same root cause as the empty-invoice crash

> Keep this body byte-for-byte: unknown keys and markdown must survive rewrites.
