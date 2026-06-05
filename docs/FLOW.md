# TinyAgent Flow

```mermaid
flowchart TD
  User["User / operator"]
  CLI["tinyagent CLI"]
  Project["Project directory<br/>.tinyagent state"]
  Registry["Pinned Lowkey registry<br/>vendor/lowkey"]
  Secrets["Secret inputs<br/>wallet signature / API keys"]
  Provider["Provider boundary<br/>local, docker, dstack"]
  Runner["tinyagent runner image"]
  Pack["Lowkey agent pack"]
  Backup["Encrypted backup engine"]
  TinyCloud["TinyCloud Store / SecretStore"]
  Attest["Attestation verifier"]
  Phala["Phala verifier / dstack evidence"]

  User --> CLI
  CLI -->|"init / agents info"| Registry
  CLI -->|"init"| Project
  CLI -->|"secrets / backup / recover"| Secrets
  CLI -->|"deploy / status / tunnel / down"| Provider
  Provider -->|"execute-provider"| Runner
  Runner --> Pack
  Pack -->|"state dirs / ports"| Project

  CLI -->|"backup"| Backup
  Backup -->|"chunk + encrypt"| TinyCloud
  CLI -->|"recover / restore"| Backup
  Backup -->|"decrypt + restore"| Project

  CLI -->|"attest verify"| Attest
  Provider -->|"deployment evidence"| Attest
  Attest -->|"optional production verification"| Phala

  classDef boundary fill:#f7f3eb,stroke:#938575,color:#1c241e;
  classDef runtime fill:#e8f1e4,stroke:#607b56,color:#152016;
  classDef external fill:#edf0f6,stroke:#687994,color:#151a24;

  class CLI,Project,Registry,Backup,Attest boundary;
  class Provider,Runner,Pack runtime;
  class TinyCloud,Phala,Secrets external;
```

## Current Trust Boundary

- Local and Docker provider flows are exercised by automated tests.
- The `dstack-cvm` provider path is wired through the Phala CLI, but production dstack deployment evidence still requires live credentials and service access.
- The package-local dstack simulator is useful for provider contract tests and must not be documented as production behavior.
