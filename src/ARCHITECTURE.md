# Architecture

Layered / ports-and-adapters structure. Dependency direction is one-way,
enforced by convention (not yet by lint rule):

```
app/            Expo Router routes — thin. Registers screens, no logic.
  -> src/ui

src/ui/         Screens, components, theme. Presentation only.
  -> src/domain

src/domain/     Entities, use-cases, repository interfaces (ports).
                Pure TypeScript. No react-native, no expo-* imports.
                Nothing else in src/ may be imported here.

src/data/       Repository implementations (adapters) for src/domain
                interfaces. Phase 1: mock data sources. Later: real
                network/DB-backed repositories.
  -> src/domain, src/infrastructure

src/infrastructure/  Platform/native adapters: secure storage, network
                clients, push, etc. Wraps third-party and native APIs
                behind interfaces owned by src/domain. No business logic.
  -> src/domain (interfaces only)

src/core/       Cross-cutting: shared types, constants, pure utils.
                No side effects. Depended on by any layer; depends on
                nothing else in src/.
```

Rule of thumb: `domain` defines the interfaces; `data` and
`infrastructure` implement them; `ui` consumes them through the
interfaces, never the concrete implementation. This keeps security-
sensitive logic (auth, crypto, messaging — none implemented yet)
isolated in `domain`/`infrastructure` and swappable/testable without
touching `ui`.
