FROM python:3.12-slim

WORKDIR /service

# hdbscan has no prebuilt wheel for every platform/Python combo and falls
# back to a from-source build that needs a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
