# usecases

Application-specific business rules, one action per file (e.g.
`sendMessage.ts`). Depend only on `entities` and `repositories`
interfaces from this layer — never on `data`, `infrastructure`, or `ui`.
