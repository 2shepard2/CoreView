FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "git+https://github.com/Sendspin/aiosendspin.git@755f34b804ad776eb702c31caf5d3527db0c182e"

COPY adapter.py ./

RUN useradd --system --uid 10001 adapter && mkdir -p /app/data && chown -R adapter:adapter /app

USER adapter

EXPOSE 8928 8929

CMD ["python", "adapter.py"]
