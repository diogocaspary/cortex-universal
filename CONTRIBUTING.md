# Contributing

Changes to the universal core require stronger review than changes to modules or profiles.

1. Open a branch named `feature/<description>` or `fix/<description>`.
2. Add or update competency questions before changing semantics.
3. Add a migration note for renamed or removed IRIs.
4. Add valid and invalid fixtures for every new SHACL constraint.
5. Run `npm run check`.
6. Document security implications and backwards compatibility in the pull request.

Do not place business-specific terms in `ontology/core`. Add them to a reusable module, a sector profile, or a tenant extension.
