# Scufris

Local-first dashboard for monitoring and controlling a computer.

## Development

```bash
nix develop
cd web && npm install && npm run build
cd ..
cargo build -p cpu
cargo run -p dashboardd
```

Open the Swagger API documentation at the logged `/docs` URL.
