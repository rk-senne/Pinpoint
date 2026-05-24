# How to Run Pinpoint

## Prerequisites

- Node.js >= 20
- Docker & Docker Compose (for full-stack or just the database)

## Option 1: Docker Compose (recommended)

Starts Postgres, runs migrations, API server, and Dashboard in one command:

```bash
docker compose up
```

- Dashboard: http://localhost:4173
- API: http://localhost:3001

## Option 2: Local Development

### 1. Start Postgres

Either use Docker for just the database:

```bash
docker compose up db
```

Or use a local Postgres instance with a `pinpoint` database.

### 2. Configure environment

```bash
cp .env.example server/.env.local
```

Edit `server/.env.local` with your database credentials.

### 3. Install dependencies

```bash
npm install
```

### 4. Build shared package

```bash
npm run build -w shared
```

### 5. Run migrations

```bash
npm run migrate -w server
```

### 6. Start the API server

```bash
npm run build -w server
npm run start -w server
```

API available at http://localhost:3001

### 7. Start the Dashboard (dev mode)

In a separate terminal:

```bash
npm run dev -w dashboard
```

Dashboard available at http://localhost:5173

## Running Tests

```bash
npm test
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| DB_HOST | Postgres host | localhost |
| DB_PORT | Postgres port | 5432 |
| DB_NAME | Database name | pinpoint |
| DB_USER | Database user | postgres |
| DB_PASSWORD | Database password | — |
| JWT_SECRET | Secret for JWT signing | — |
| PORT | API server port | 3001 |
| CORS_ORIGIN | Allowed CORS origin | http://localhost:5173 |
| APP_URL | Dashboard URL (used in emails) | http://localhost:5173 |
| SMTP_HOST | Email server host | — |
| SMTP_PORT | Email server port | 587 |
| S3_BUCKET | S3 bucket for file uploads | — |
| S3_REGION | AWS region for S3 | — |
