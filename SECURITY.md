# Security

Do not publish exploit details, credentials or wallet keys in an issue. Report privately through GitHub's private vulnerability reporting when enabled; otherwise ask the maintainer for a private reporting channel without including exploit details.

The API never requires a treasury private key. Protect ADMIN_API_KEY, provider keys and facilitator credentials. Production refuses payment bypass. Paid access relies on the configured x402 facilitator and its verification/settlement guarantees. This application is not an audited trading system. Use a single replica until shared persistence and rate limits are implemented.
