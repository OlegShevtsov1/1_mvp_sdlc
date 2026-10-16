---
status: Draft
owner: "QA owner"
updated_at: "2026-10-03"
feature_size: "S"
---

# Test plan — demo

## AC coverage

| AC (PRD.md §5) | Test name (intent-based) | Level | Expected outcome |
|---|---|---|---|
| AC-01 happy path | manager exports this month's orders | unit + e2e | one row per order, export confirmed |
| AC-02 error | export of an empty period is refused | unit | nothing-to-export message, no file |
| AC-03 authorization | export of another shop is refused | integration | refused, nothing revealed |
