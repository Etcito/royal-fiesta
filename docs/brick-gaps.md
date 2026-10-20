# Brick gaps

## raa

API v0 was not found in the RAA checkout (RAA_DIR) on 2026-10-18: the repo holds only Cargo.toml, LICENSE and README.md (a Rust/WebAssembly engine), with no documented web entry or v0 marker export. The browser client therefore uses the null render port. `createRaaPort` refuses with the detection reason and makes no RAA calls.
