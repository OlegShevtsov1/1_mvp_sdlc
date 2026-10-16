---
status: Approved
---

# PRD — orders

## 4. User stories

### US-01: Look up an order

**As a** shop manager
**I want** to look up an order
**So that** I can answer a customer

## 5. Acceptance criteria

<!-- Skill instruction: never write status 404, GET /api/v1/orders, SELECT or "the `orders` table" in an AC. -->

### AC-01 (US-01) — happy path

**Given** a shop manager with an open order
**When** the manager sends POST /api/v1/orders
**Then** the system answers with status 201

### AC-02 (US-01) — error

**Given** a shop manager
**When** the manager looks up an order that does not exist
**Then** the response code is 404

### AC-03 (US-01) — domain invariant

**Given** the `orders` table holds the order
**When** the system runs SELECT on it
**Then** the row is returned WHERE the owner matches

```text
UPDATE inside a fenced block is ignored
```

## 6. Non-functional requirements

| Aspect | Target | Measurement |
|---|---|---|
| Latency of GET /api/v1/orders | status 200 in ≤ 250 ms | SELECT timing from the orders_log table |
