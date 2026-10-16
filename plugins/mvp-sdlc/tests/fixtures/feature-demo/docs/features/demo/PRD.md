---
status: Approved
owner: "Product owner"
reviewers: ["Tech Lead", "Security Lead"]
updated_at: "2026-10-02"
feature_size: "S"
stage: "03"
---

# PRD — demo

## 1. Context

Shop managers retype order lists for the accounting team every month. This feature lets them export the orders of
their own shop as a spreadsheet file.

## 4. User stories

### US-01: Export shop orders

**As a** shop manager
**I want** to export the orders of my shop
**So that** the accounting team gets them without retyping

## 5. Acceptance criteria

<!-- Skill instruction: business language only. Never write GET /api/v1/orders, status 404 or SELECT here. -->

### AC-01 (US-01) — happy path

**Given** a shop manager whose shop has orders this month
**When** the manager asks for an export of this month's orders
**Then** the system delivers a spreadsheet file with one row per order and confirms the export

### AC-02 (US-01) — error

**Given** a shop manager whose shop has no orders in the chosen period
**When** the manager asks for an export of that period
**Then** the system explains that there is nothing to export and delivers no file

### AC-03 (US-01) — authorization

**Given** a shop manager of one shop
**When** the manager asks for an export of another shop's orders
**Then** the system refuses and does not reveal whether that shop has any orders

## 6. Non-functional requirements

| Aspect | Target | Measurement |
|---|---|---|
| Export time p95 | ≤ 5 s for 10 000 orders | request timing metric |
