---
paths:
  - "src/**"
  - "app/**"
---

# Frontend

- Reuse the existing design system, components and tokens; create a new component only when no existing one fits,
  and say why in the pull request.
- Server state comes only from operations in the synced `contracts/`; do not invent fields the contract does not
  define.
- Every user-visible error from the backend has a plain-language message; never show raw error payloads.
- Components get component tests for their states (empty, loading, error, populated) and interactions.
- Accessibility is part of done: labels for inputs, keyboard reachability, sufficient contrast.
- No secrets in frontend code or build-time variables: everything shipped to the browser is public.
