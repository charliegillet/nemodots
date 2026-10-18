# Ratchet sandbox image (owner: I1). Runs worker snippets and hidden tests with --network none.
# Build: docker build -t ratchet-sandbox:py312 docker/sandbox   (ratchet.sandbox also builds on demand)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir pytest==8.3.3
WORKDIR /work
