---
status: Approved
---

# PRD — orders

## 5. Acceptance criteria

<!-- Skill instruction: never write status 404, GET /api/v1/orders or SELECT here. -->

### AC-01 (US-01) — happy path

**Given** a shop manager who wants to update the delivery address of an open order
**When** the manager saves the new address where the courier can find it
**Then** the system records the address and confirms the update

### AC-02 (US-01) — domain invariant

**Given** a shop manager who sees the pricing table of 3 plans and 200 products in the catalogue
**When** the manager picks a plan that is no longer sold
**Then** the system blocks the choice and explains that only current plans can be picked

## 6. Non-functional requirements

| Aspect | Target | Measurement |
|---|---|---|
| Latency of GET /api/v1/orders | status 200 in ≤ 250 ms | SELECT timing |
