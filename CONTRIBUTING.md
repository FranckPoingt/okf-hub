# Contributing

OKF Hub is in beta. Please discuss substantial product or architecture changes
before implementing them.

## Development

Install Deno 2.9 and Docker with Compose, then run:

```sh
deno ci
deno task stack
deno task dev
```

Portless is optional; use `deno task stack:portless` and
`deno task dev:portless` if you prefer named local URLs.

Before opening a pull request:

```sh
deno fmt --check
deno task test
```

Keep pull requests focused and do not commit credentials, `.env` files,
`.okf-stack.env`, private keys, or `config/sso.json`. See [PLAN.md](PLAN.md) for
the product architecture and [docs/README.md](docs/README.md) for user-facing
behavior.
