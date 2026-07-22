# Build context is the repo root (see docker-compose*.yml) because this needs pyproject.toml
# and src/ from there — `kathara>=3.8.3` is a published PyPI dependency, not the sibling
# ../Kathara checkout used for local editable-install development (see README).
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir .

# Kathara's Docker manager talks to the Docker SDK, not a nested Docker daemon: it creates
# lab devices as *sibling* containers on the host via /var/run/docker.sock (mounted in
# docker-compose*.yml) rather than inside this container. No docker CLI/daemon needed here.
EXPOSE 8000

ENV KATHARA_API_HOST=0.0.0.0 \
    KATHARA_API_PORT=8000

CMD ["kathara-api"]
