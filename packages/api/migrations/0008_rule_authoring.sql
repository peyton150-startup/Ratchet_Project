-- Ratchet Phase 4: rule authoring from the admin console.
-- Publishing a new rule version deactivates the previous active version, so the app role needs
-- UPDATE on rules (it previously only had SELECT/INSERT for the engine's read path).

GRANT UPDATE ON rules TO ratchet_app;
