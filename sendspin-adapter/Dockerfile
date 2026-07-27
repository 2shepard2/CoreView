FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Match Music Assistant's installed SDK version. SendSpin is a technical
# preview, so its protocol surface must be pinned to the server we target.
RUN pip install --no-cache-dir "git+https://github.com/Sendspin/aiosendspin.git@d488d0b8b1457b1780658b37a35dcfc3102741fc"

COPY adapter.py ./

RUN useradd --system --uid 10001 adapter && mkdir -p /app/data && chown -R adapter:adapter /app

USER adapter

EXPOSE 8928 8929

CMD ["python", "adapter.py"]
