# Integration tests need the real data stores and NATS (docker compose up -d; CI starts them as services).
exclude = if System.get_env("INTEGRATION") in ["1", "true"], do: [], else: [:integration]
ExUnit.start(exclude: exclude)
