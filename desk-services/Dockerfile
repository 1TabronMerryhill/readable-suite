# OpOne Capital Desk feed pipeline service (Railway).
#
# Base: Eclipse Temurin 17 JDK. g++ builds the tick normalizer, python3
# runs the Finnhub transport, the feeder, and the consumer. No secrets in
# this image: the Finnhub key and the bus token arrive as Railway env vars.
# Railway provides PORT; start.sh binds the bus to 0.0.0.0 on that port.
FROM eclipse-temurin:17-jdk

RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Java event bus (compiled here; no .class files are committed)
COPY java/EventBus.java java/
RUN javac java/EventBus.java

# C++ tick normalizer (compiled here; no binary is committed)
COPY cpp/TickNormalizer.cpp cpp/
RUN g++ -std=c++17 -O2 -Wall -Wextra -o tick-normalizer cpp/TickNormalizer.cpp

# Python: consumer, feeder, Finnhub transport (Railway copy)
COPY python/ python/

# Consumer baseline: the Nov 6, 2026 desk-data snapshot
COPY data/desk-data.json data/desk-data.json

COPY start.sh start.sh
RUN chmod +x start.sh

CMD ["./start.sh"]
