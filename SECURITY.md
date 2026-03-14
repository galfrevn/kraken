# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability in Kraken, please report it responsibly.

**Do not open a public issue.**

Instead, email **security@galfrevn.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 48 hours. We'll work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

The following areas are in scope for security reports:

- **Command injection** through agent tools or shell execution
- **Credential exposure** in configuration, logs, or storage
- **Unauthorized access** to the gateway or scheduler services
- **Plugin sandbox escapes** or privilege escalation
- **SQLite injection** through the storage layer
- **API key leakage** through the LLM proxy

## Acknowledgments

We appreciate the security research community's efforts. Contributors who report valid vulnerabilities will be credited in the release notes (unless they prefer to remain anonymous).
