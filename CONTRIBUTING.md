# Contributing to Herald

Thanks for helping. Herald is an early draft, so design feedback is as valuable as code.

## Ways to help

- **Spec feedback.** Open an issue that names the section of [SPEC.md](SPEC.md) and the problem. Security concerns about the trust model are especially welcome.
- **New announcement types.** Propose them in an issue first. Include the `data` fields and a real example.
- **Implementations.** Ports to other languages, and integrations with MCP clients and servers.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bunx tsc -p .
```

Pull requests must pass tests and the type check. Add a test for every behaviour change.

## Spec changes

A change to the wire format or to agent behaviour must update `SPEC.md` and the reference implementation in the same pull request.

## Security

Do not open a public issue for a vulnerability. Report it privately through GitHub's "Report a vulnerability" button on this repository.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
